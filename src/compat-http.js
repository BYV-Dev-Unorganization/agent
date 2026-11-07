import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  normalizeOpenAIRequest,
  normalizeAnthropicRequest,
  estimateTokens
} from "./compat.js";
import {
  parseDsmlToolCalls,
  validateToolCalls,
  hasRepeatedToolCallLoop
} from "./tool-calling.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_TOOL_RECOVERY_ATTEMPTS = 2;

function isAuthorized(req, token, protocol) {
  if (!token) return true;

  const authorization = req.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const apiKey = protocol === "anthropic" ? String(req.headers["x-api-key"] ?? "") : "";
  const supplied = apiKey || bearer;
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length &&
    expectedBytes.length > 0 &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

function sendProtocolError(res, protocol, status, message, sendJson) {
  if (res.destroyed || res.writableEnded) return;
  if (protocol === "openai") {
    const type = status === 401 ? "authentication_error" :
      status >= 500 ? "server_error" : "invalid_request_error";
    return sendJson(res, status, {
      error: {
        message,
        type,
        param: null,
        code: status === 401 ? "invalid_api_key" : status >= 500 ? "agent_i_error" : null
      }
    });
  }

  const type = status === 401 ? "authentication_error" :
    status >= 500 ? "api_error" : "invalid_request_error";
  return sendJson(res, status, {
    type: "error",
    error: { type, message }
  });
}

function openAIErrorEvent(res, message) {
  res.write("data: " + JSON.stringify({
    error: { message, type: "server_error", param: null, code: "agent_i_error" }
  }) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

function anthropicErrorEvent(res, message) {
  res.write("event: error\n");
  res.write("data: " + JSON.stringify({
    type: "error",
    error: { type: "api_error", message }
  }) + "\n\n");
  res.end();
}

function openAIChunk(res, id, created, model, delta, finishReason = null) {
  res.write("data: " + JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }) + "\n\n");
}

function anthropicEvent(res, event, payload) {
  res.write("event: " + event + "\n");
  res.write("data: " + JSON.stringify(payload) + "\n\n");
}

function splitForStream(text, size = 900) {
  const points = Array.from(text);
  const chunks = [];
  for (let i = 0; i < points.length; i += size) {
    chunks.push(points.slice(i, i + size).join(""));
  }
  return chunks;
}

function makeToolCallIds(calls, protocol) {
  return calls.map((call) => ({
    id: (protocol === "anthropic" ? "toolu_" : "call_") + randomUUID().replaceAll("-", ""),
    name: call.name,
    input: call.input
  }));
}

function buildOpenAIResponse(outcome, request, promptTokens) {
  const text = outcome.text ?? "";
  const toolCalls = outcome.toolCalls ?? [];
  const completionTokens = estimateTokens(text + toolCalls.map((call) => JSON.stringify(call.input)).join(""));
  const message = {
    role: "assistant",
    content: toolCalls.length ? (text || null) : text
  };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.input)
      }
    }));
  }

  return {
    id: "chatcmpl-" + randomUUID().replaceAll("-", ""),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? "tool_calls" : "stop"
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

function buildAnthropicResponse(outcome, request, promptTokens) {
  const text = outcome.text ?? "";
  const toolCalls = outcome.toolCalls ?? [];
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input
    });
  }
  return {
    id: "msg_" + randomUUID().replaceAll("-", ""),
    type: "message",
    role: "assistant",
    model: request.model,
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: estimateTokens(text + toolCalls.map((call) => JSON.stringify(call.input)).join(""))
    }
  };
}

async function waitForJob(readJob, jobId, onPending, isClosed) {
  let lastPing = Date.now();
  while (true) {
    if (isClosed?.()) return null;
    const job = readJob(jobId);
    if (!job) {
      const error = new Error("Job disappeared before it completed");
      error.status = 500;
      throw error;
    }
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      const error = new Error(job.error || "Agent I job failed");
      error.status = 502;
      throw error;
    }
    if (onPending && Date.now() - lastPing >= 10000) {
      if (onPending() === false) return null;
      lastPing = Date.now();
    }
    await sleep(200);
  }
}

function toolRecoveryInstruction(request, reason, forceTextOnly) {
  const recovery = forceTextOnly
    ? [
        "TOOL LOOP RECOVERY:",
        "A repeated identical tool call was detected. Do not call any tool again in this turn.",
        "Do not emit DSML markup. Give the best possible plain-text answer using the conversation and tool results already available."
      ]
    : [
        "TOOL CALL FORMAT RECOVERY:",
        "Your previous response did not contain a valid DSML tool call.",
        "Fix the issue described below. Emit exactly one valid DSML calls block when a tool is required.",
        "Use only declared tool names and schema-valid arguments. Do not add explanatory text outside the calls block.",
        "Validation error: " + reason
      ];
  return request.instruction + "\n\n" + recovery.join("\n");
}

async function resolveToolOutcome(initialJob, initialPayload, request, protocol, context, onPending, isClosed) {
  if (!request.hasTools) {
    return { job: initialJob, text: initialJob.result, toolCalls: [] };
  }

  let job = initialJob;
  let forceTextOnly = request.toolChoice.mode === "none";
  let failure = forceTextOnly
    ? "tool_choice=none disables all tool calls."
    : "The model did not return a tool call.";
  for (let attempt = 0; attempt <= MAX_TOOL_RECOVERY_ATTEMPTS; attempt += 1) {
    const parsed = parseDsmlToolCalls(job.result);
    if (!parsed.sawToolMarkup) {
      if (forceTextOnly || !["required", "any", "tool"].includes(request.toolChoice.mode)) {
        return { job, text: job.result, toolCalls: [] };
      }
      failure = "tool_choice requires a tool call, but the response contained no DSML calls block.";
    } else if (parsed.errors.length) {
      failure = parsed.errors.join(" ");
    } else {
      const validation = validateToolCalls(
        parsed.calls,
        request.tools,
        forceTextOnly ? { mode: "none" } : request.toolChoice
      );
      if (!validation.valid) {
        failure = validation.error;
      } else if (hasRepeatedToolCallLoop(parsed.calls, request.previousToolCalls)) {
        failure = "An identical tool call was already requested twice in the recent conversation.";
        forceTextOnly = true;
      } else {
        return {
          job,
          text: parsed.text,
          toolCalls: makeToolCallIds(parsed.calls, protocol)
        };
      }
    }

    if (attempt === MAX_TOOL_RECOVERY_ATTEMPTS) break;
    const retryPayload = {
      ...initialPayload,
      conversationId: initialJob.conversationId,
      mode: "direct",
      instruction: toolRecoveryInstruction(request, failure, forceTextOnly)
    };
    const retry = context.insertJob(context.db, retryPayload);
    job = await waitForJob(
      (id) => context.readJob(context.db, id),
      retry.jobId,
      onPending,
      isClosed
    );
    if (!job || isClosed?.()) return null;
  }

  const error = new Error("Agent I could not produce a valid tool call after recovery: " + failure);
  error.status = 502;
  throw error;
}

async function sendOpenAIStream(res, getOutcome, request) {
  const id = "chatcmpl-" + randomUUID().replaceAll("-", "");
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();
  openAIChunk(res, id, created, request.model, { role: "assistant" });

  let outcome;
  try {
    outcome = await getOutcome(() => {
      if (res.destroyed || res.writableEnded) return false;
      res.write(": keep-alive\n\n");
      return true;
    }, () => res.destroyed || res.writableEnded);
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) openAIErrorEvent(res, error.message);
    return;
  }
  if (!outcome || res.destroyed || res.writableEnded) return;

  for (const chunk of splitForStream(outcome.text ?? "")) {
    openAIChunk(res, id, created, request.model, { content: chunk });
  }
  const toolCalls = outcome.toolCalls ?? [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    openAIChunk(res, id, created, request.model, {
      tool_calls: [{
        index,
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input)
        }
      }]
    });
  }
  openAIChunk(res, id, created, request.model, {}, toolCalls.length ? "tool_calls" : "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

async function sendAnthropicStream(res, getOutcome, request, promptTokens) {
  const id = "msg_" + randomUUID().replaceAll("-", "");
  const message = {
    id,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: promptTokens, output_tokens: 0 }
  };
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();
  anthropicEvent(res, "message_start", { type: "message_start", message });

  let outcome;
  try {
    outcome = await getOutcome(() => {
      if (res.destroyed || res.writableEnded) return false;
      res.write(": keep-alive\n\n");
      return true;
    }, () => res.destroyed || res.writableEnded);
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) anthropicErrorEvent(res, error.message);
    return;
  }
  if (!outcome || res.destroyed || res.writableEnded) return;

  let blockIndex = 0;
  if (outcome.text) {
    anthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" }
    });
    for (const chunk of splitForStream(outcome.text)) {
      anthropicEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: chunk }
      });
    }
    anthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    blockIndex += 1;
  }

  const toolCalls = outcome.toolCalls ?? [];
  for (const call of toolCalls) {
    anthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: {}
      }
    });
    anthropicEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.input)
      }
    });
    anthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    blockIndex += 1;
  }

  const outputTokens = estimateTokens((outcome.text ?? "") +
    toolCalls.map((call) => JSON.stringify(call.input)).join(""));
  anthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: toolCalls.length ? "tool_use" : "end_turn",
      stop_sequence: null
    },
    usage: { output_tokens: outputTokens }
  });
  anthropicEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

/**
 * Handles the synchronous OpenAI Chat Completions and Anthropic Messages
 * compatibility routes by submitting work to the existing durable job queue.
 */
export async function handleCompatRequest(req, res, context) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const isModels = req.method === "GET" && url.pathname === "/v1/models";
  const protocol = req.method === "POST" && url.pathname === "/v1/messages"
    ? "anthropic"
    : ((req.method === "POST" && url.pathname === "/v1/chat/completions") || isModels)
      ? "openai"
      : null;

  if (!protocol) return false;

  if (!isAuthorized(req, context.apiToken ?? "", protocol)) {
    sendProtocolError(res, protocol, 401, "A valid API key is required", context.sendJson);
    return true;
  }

  if (isModels) {
    context.sendJson(res, 200, {
      object: "list",
      data: [{ id: "agent-i", object: "model", created: 0, owned_by: "BYV-Dev-Unorganization" }]
    });
    return true;
  }

  try {
    const body = await context.readJson(req);
    const request = protocol === "openai"
      ? normalizeOpenAIRequest(body)
      : normalizeAnthropicRequest(body);
    const payload = context.normalize({
      input: request.input,
      instruction: request.instruction,
      mode: request.mode
    }, { toolCalling: request.hasTools });
    const created = context.insertJob(context.db, payload);
    res.setHeader("x-agent-i-job-id", created.jobId);
    res.setHeader("x-agent-i-conversation-id", created.conversationId);
    res.setTimeout?.(0);

    const promptTokens = estimateTokens(request.promptForUsage);
    const getOutcome = async (onPending, isClosed) => {
      const job = await waitForJob(
        (id) => context.readJob(context.db, id),
        created.jobId,
        onPending,
        isClosed
      );
      if (!job || isClosed?.()) return null;
      return resolveToolOutcome(job, payload, request, protocol, context, onPending, isClosed);
    };

    if (request.stream) {
      if (protocol === "openai") {
        await sendOpenAIStream(res, getOutcome, request);
      } else {
        await sendAnthropicStream(res, getOutcome, request, promptTokens);
      }
      return true;
    }

    const outcome = await getOutcome();
    if (!outcome || res.destroyed || res.writableEnded) return true;
    const response = protocol === "openai"
      ? buildOpenAIResponse(outcome, request, promptTokens)
      : buildAnthropicResponse(outcome, request, promptTokens);
    context.sendJson(res, 200, response);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const message = status >= 500 && status !== 502
      ? "Internal server error"
      : String(error?.message ?? error);
    sendProtocolError(res, protocol, status, message, context.sendJson);
  }

  return true;
}
