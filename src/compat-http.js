import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  normalizeOpenAIRequest,
  normalizeAnthropicRequest,
  estimateTokens
} from "./compat.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function buildOpenAIResponse(job, request, promptTokens) {
  const completionTokens = estimateTokens(job.result);
  return {
    id: "chatcmpl-" + randomUUID().replaceAll("-", ""),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: job.result },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

function buildAnthropicResponse(job, request, promptTokens) {
  return {
    id: "msg_" + randomUUID().replaceAll("-", ""),
    type: "message",
    role: "assistant",
    model: request.model,
    content: [{ type: "text", text: job.result }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: estimateTokens(job.result)
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

async function sendOpenAIStream(res, getJob, request) {
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

  let job;
  try {
    job = await getJob(() => {
      if (res.destroyed || res.writableEnded) return false;
      res.write(": keep-alive\n\n");
      return true;
    }, () => res.destroyed || res.writableEnded);
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) openAIErrorEvent(res, error.message);
    return;
  }
  if (!job || res.destroyed || res.writableEnded) return;

  for (const chunk of splitForStream(job.result)) {
    openAIChunk(res, id, created, request.model, { content: chunk });
  }
  openAIChunk(res, id, created, request.model, {}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

async function sendAnthropicStream(res, getJob, request, promptTokens) {
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
  anthropicEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });

  let job;
  try {
    job = await getJob(() => {
      if (res.destroyed || res.writableEnded) return false;
      res.write(": keep-alive\n\n");
      return true;
    }, () => res.destroyed || res.writableEnded);
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) anthropicErrorEvent(res, error.message);
    return;
  }
  if (!job || res.destroyed || res.writableEnded) return;

  for (const chunk of splitForStream(job.result)) {
    anthropicEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk }
    });
  }
  anthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  anthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: estimateTokens(job.result) }
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
    });
    const created = context.insertJob(context.db, payload);
    res.setHeader("x-agent-i-job-id", created.jobId);
    res.setHeader("x-agent-i-conversation-id", created.conversationId);
    res.setTimeout?.(0);

    const promptTokens = estimateTokens(request.promptForUsage);
    const getJob = (onPending, isClosed) =>
      waitForJob(
        (id) => context.readJob(context.db, id),
        created.jobId,
        onPending,
        isClosed
      );

    if (request.stream) {
      if (protocol === "openai") {
        await sendOpenAIStream(res, getJob, request);
      } else {
        await sendAnthropicStream(res, getJob, request, promptTokens);
      }
      return true;
    }

    const job = await getJob();
    if (!job || res.destroyed || res.writableEnded) return true;
    const response = protocol === "openai"
      ? buildOpenAIResponse(job, request, promptTokens)
      : buildAnthropicResponse(job, request, promptTokens);
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
