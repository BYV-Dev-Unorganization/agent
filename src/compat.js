import {
  buildToolInstruction,
  normalizeOpenAITools,
  normalizeAnthropicTools,
  normalizeOpenAIToolChoice,
  normalizeAnthropicToolChoice
} from "./tool-calling.js";

export class CompatRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CompatRequestError";
    this.status = status;
  }
}

function assertObject(value, label = "Request body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompatRequestError(label + " must be a JSON object");
  }
}

function readTextContent(content, label) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new CompatRequestError(label + " must be a string or an array of text blocks");
  }

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
      throw new CompatRequestError(
        label + " currently supports text blocks only; images and unsupported content blocks are not supported"
      );
    }
    parts.push(block.text);
  }
  return parts.join("");
}

function validateModel(model) {
  if (typeof model !== "string" || !model.trim()) {
    throw new CompatRequestError("model must be a non-empty string");
  }
  if (model.length > 128) throw new CompatRequestError("model must be 128 characters or fewer");
  return model.trim();
}

function validateStream(stream) {
  if (stream !== undefined && typeof stream !== "boolean") {
    throw new CompatRequestError("stream must be a boolean");
  }
  return stream === true;
}

function validateMode(mode) {
  if (mode !== undefined && !["auto", "direct", "analyze", "transform"].includes(mode)) {
    throw new CompatRequestError("mode must be auto, direct, analyze, or transform");
  }
  return mode ?? "auto";
}

function validateToolMode(body, tools) {
  const requested = validateMode(body.mode);
  if (tools.length && requested !== "auto" && requested !== "direct") {
    throw new CompatRequestError("Tool calling requires direct mode; use mode=direct or omit mode");
  }
  return tools.length ? "direct" : requested;
}

function normalizeTools(normalizer, tools, toolChoice) {
  try {
    const normalized = normalizer(tools);
    const choice = toolChoice === undefined
      ? (normalizer === normalizeOpenAITools
        ? normalizeOpenAIToolChoice(undefined, normalized)
        : normalizeAnthropicToolChoice(undefined, normalized))
      : (normalizer === normalizeOpenAITools
        ? normalizeOpenAIToolChoice(toolChoice, normalized)
        : normalizeAnthropicToolChoice(toolChoice, normalized));
    return { tools: normalized, toolChoice: choice };
  } catch (error) {
    throw new CompatRequestError(String(error?.message ?? error));
  }
}

function makeInstruction(systemParts, explicitInstruction) {
  if (explicitInstruction !== undefined && typeof explicitInstruction !== "string") {
    throw new CompatRequestError("instruction must be a string");
  }
  return [
    ...systemParts.filter((part) => part.trim()),
    ...(explicitInstruction?.trim() ? [explicitInstruction.trim()] : []),
    "Use the conversation below as context and answer the latest user message. Follow the system/developer and tool protocol instructions above."
  ].join("\n\n");
}

function formatOpenAIAssistantToolCalls(calls, label) {
  if (calls === undefined) return "";
  if (!Array.isArray(calls)) throw new CompatRequestError(label + ".tool_calls must be an array");
  const parts = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (!call || typeof call !== "object" || call.type !== "function" ||
        !call.function || typeof call.function.name !== "string" ||
        typeof call.function.arguments !== "string") {
      throw new CompatRequestError(label + ".tool_calls[" + index + "] is invalid");
    }
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw new CompatRequestError(label + ".tool_calls[" + index + "].function.arguments must be valid JSON"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new CompatRequestError(label + ".tool_calls[" + index + "].function.arguments must be a JSON object");
    }
    parts.push("[assistant tool call id=" + String(call.id ?? "unknown") + " name=" +
      call.function.name + "]\n" + JSON.stringify(args));
  }
  return parts.join("\n\n");
}

function formatAnthropicBlocks(content, role, label) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new CompatRequestError(label + " must be a string or an array of content blocks");
  }

  const parts = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new CompatRequestError(label + "[" + index + "] must be a content block");
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "tool_use" && role === "assistant") {
      if (typeof block.name !== "string" || typeof block.id !== "string" ||
          !block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
        throw new CompatRequestError(label + "[" + index + "] is an invalid tool_use block");
      }
      parts.push("[assistant tool_use id=" + block.id + " name=" + block.name + "]\n" +
        JSON.stringify(block.input));
      continue;
    }
    if (block.type === "tool_result" && role === "user") {
      if (typeof block.tool_use_id !== "string" || !block.tool_use_id) {
        throw new CompatRequestError(label + "[" + index + "].tool_use_id is required");
      }
      const result = typeof block.content === "string"
        ? block.content
        : readTextContent(block.content, label + "[" + index + "].content");
      parts.push("[tool_result id=" + block.tool_use_id +
        (block.is_error === true ? " status=error" : "") + "]\n" + result);
      continue;
    }
    throw new CompatRequestError(
      label + "[" + index + "] uses an unsupported content block type"
    );
  }
  return parts.join("\n\n");
}

function formatConversation(messages, allowedRoles, protocol) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new CompatRequestError("messages must be a non-empty array");
  }

  const parts = [];
  const previousToolCalls = [];
  let hasUser = false;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new CompatRequestError("messages[" + index + "] must be an object");
    }
    if (!allowedRoles.includes(message.role)) {
      throw new CompatRequestError(
        "messages[" + index + "].role is not supported; expected " + allowedRoles.join(" or ")
      );
    }

    let content;
    if (protocol === "openai") {
      const text = readTextContent(message.content, "messages[" + index + "].content");
      const toolCalls = formatOpenAIAssistantToolCalls(message.tool_calls, "messages[" + index + "]");
      if (message.tool_calls !== undefined && message.role !== "assistant") {
        throw new CompatRequestError("Only assistant messages may contain tool_calls");
      }
      if (toolCalls) {
        content = [text, toolCalls].filter((part) => part.trim()).join("\n\n");
        const previousTurn = [];
        for (const call of message.tool_calls) {
          try {
            previousTurn.push({
              name: call.function.name,
              input: JSON.parse(call.function.arguments)
            });
          } catch { /* already validated above */ }
        }
        if (previousTurn.length) previousToolCalls.push(previousTurn);
      } else if (message.role === "tool") {
        if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
          throw new CompatRequestError("messages[" + index + "].tool_call_id is required for tool messages");
        }
        content = "[tool_result id=" + message.tool_call_id + "]\n" + text;
      } else {
        content = text;
      }
    } else {
      content = formatAnthropicBlocks(message.content, message.role, "messages[" + index + "].content");
      if (message.role === "assistant" && Array.isArray(message.content)) {
        const previousTurn = message.content
          .filter((block) => block?.type === "tool_use" && block.input && typeof block.input === "object" && !Array.isArray(block.input))
          .map((block) => ({ name: block.name, input: block.input }));
        if (previousTurn.length) previousToolCalls.push(previousTurn);
      }
    }

    if (!content.trim()) continue;
    if (message.role === "user") hasUser = true;
    parts.push("[" + message.role + "]\n" + content);
  }

  if (!hasUser) throw new CompatRequestError("messages must contain at least one non-empty user message");
  if (!parts.length) throw new CompatRequestError("messages contain no text");
  return { input: parts.join("\n\n"), previousToolCalls };
}

/**
 * Translate an OpenAI Chat Completions request into the backend's common job input.
 * Sampling parameters are accepted for SDK compatibility but the Agent I upstream
 * does not expose controls for them.
 */
export function normalizeOpenAIRequest(body) {
  assertObject(body);
  if (body.n !== undefined && body.n !== 1) {
    throw new CompatRequestError("Only n=1 is supported");
  }
  if (body.functions !== undefined && body.functions !== null) {
    throw new CompatRequestError("Legacy functions are not supported; use the tools field");
  }

  const { tools, toolChoice } = normalizeTools(
    normalizeOpenAITools,
    body.tools,
    body.tool_choice
  );
  const model = validateModel(body.model);
  const stream = validateStream(body.stream);
  const systemParts = [];
  const conversationMessages = [];

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new CompatRequestError("messages must be a non-empty array");
  }

  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new CompatRequestError("messages[" + index + "] must be an object");
    }
    if (message.role === "system" || message.role === "developer") {
      const text = readTextContent(message.content, "messages[" + index + "].content");
      if (message.tool_calls !== undefined) {
        throw new CompatRequestError("System/developer messages cannot contain tool_calls");
      }
      if (text.trim()) systemParts.push("[" + message.role + "]\n" + text);
    } else {
      conversationMessages.push(message);
    }
  }

  const conversation = formatConversation(conversationMessages, ["user", "assistant", "tool"], "openai");
  const mode = validateToolMode(body, tools);
  const toolInstruction = buildToolInstruction(tools, toolChoice);
  const explicitInstruction = [body.instruction, ...(tools.length ? [toolInstruction] : [])]
    .filter((part) => typeof part === "string" && part.trim()).join("\n\n");
  const instruction = makeInstruction(systemParts, explicitInstruction);
  return {
    model,
    input: conversation.input,
    instruction,
    mode,
    stream,
    tools,
    toolChoice,
    previousToolCalls: conversation.previousToolCalls,
    hasTools: tools.length > 0,
    promptForUsage: instruction + "\n\n" + conversation.input
  };
}

/**
 * Translate an Anthropic Messages request into the backend's common job input.
 * Text, tool_use, and tool_result blocks are supported. Images remain unsupported.
 */
export function normalizeAnthropicRequest(body) {
  assertObject(body);
  const { tools, toolChoice } = normalizeTools(
    normalizeAnthropicTools,
    body.tools,
    body.tool_choice
  );

  const model = validateModel(body.model);
  const stream = validateStream(body.stream);
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) {
    throw new CompatRequestError("max_tokens must be a positive integer");
  }

  const systemParts = [];
  if (body.system !== undefined) {
    const systemText = readTextContent(body.system, "system");
    if (systemText.trim()) systemParts.push("[system]\n" + systemText);
  }

  const conversation = formatConversation(body.messages, ["user", "assistant"], "anthropic");
  const mode = validateToolMode(body, tools);
  const toolInstruction = buildToolInstruction(tools, toolChoice);
  const explicitInstruction = [body.instruction, ...(tools.length ? [toolInstruction] : [])]
    .filter((part) => typeof part === "string" && part.trim()).join("\n\n");
  const instruction = makeInstruction(systemParts, explicitInstruction);
  return {
    model,
    input: conversation.input,
    instruction,
    mode,
    stream,
    maxTokens: body.max_tokens,
    tools,
    toolChoice,
    previousToolCalls: conversation.previousToolCalls,
    hasTools: tools.length > 0,
    promptForUsage: instruction + "\n\n" + conversation.input
  };
}

/**
 * Token counts are estimates only. The upstream Agent I service does not return
 * OpenAI/Anthropic tokenizer usage metadata.
 */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4));
}
