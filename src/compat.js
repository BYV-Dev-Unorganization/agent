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
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new CompatRequestError(label + " must be a string or an array of text blocks");
  }

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
      throw new CompatRequestError(
        label + " currently supports text blocks only; images and tool blocks are not supported yet"
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

function rejectTools(body, protocol) {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new CompatRequestError(protocol + " tools are not supported yet; omit the tools field");
  }
  if (body.tool_choice !== undefined && body.tool_choice !== "none") {
    throw new CompatRequestError(protocol + " tool_choice is not supported yet");
  }
  if (body.functions !== undefined && body.functions !== null) {
    throw new CompatRequestError("Legacy function calling is not supported yet");
  }
}

function makeInstruction(systemParts, explicitInstruction) {
  if (explicitInstruction !== undefined && typeof explicitInstruction !== "string") {
    throw new CompatRequestError("instruction must be a string");
  }
  return [
    ...systemParts.filter((part) => part.trim()),
    ...(explicitInstruction?.trim() ? [explicitInstruction.trim()] : []),
    "Use the conversation below as context and answer the latest user message. Follow the system/developer instructions above."
  ].join("\n\n");
}

function formatConversation(messages, allowedRoles, protocol) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new CompatRequestError("messages must be a non-empty array");
  }

  const parts = [];
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
    const content = readTextContent(message.content, "messages[" + index + "].content");
    if (!content.trim()) continue;
    if (message.role === "user") hasUser = true;
    parts.push("[" + message.role + "]\n" + content);
  }

  if (!hasUser) throw new CompatRequestError("messages must contain at least one non-empty user message");
  if (!parts.length) throw new CompatRequestError("messages contain no text");
  return parts.join("\n\n");
}

/**
 * Translate an OpenAI Chat Completions request into the backend's common job input.
 * Sampling parameters are accepted for SDK compatibility but the Agent I upstream
 * does not expose controls for them.
 */
export function normalizeOpenAIRequest(body) {
  assertObject(body);
  rejectTools(body, "OpenAI");
  if (body.n !== undefined && body.n !== 1) {
    throw new CompatRequestError("Only n=1 is supported");
  }

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
      if (text.trim()) systemParts.push("[" + message.role + "]\n" + text);
    } else {
      conversationMessages.push(message);
    }
  }

  const input = formatConversation(conversationMessages, ["user", "assistant"], "OpenAI");
  const instruction = makeInstruction(systemParts, body.instruction);
  return {
    model,
    input,
    instruction,
    mode: validateMode(body.mode),
    stream,
    promptForUsage: instruction + "\n\n" + input
  };
}

/**
 * Translate an Anthropic Messages request into the backend's common job input.
 * Text blocks are supported. Images and tool blocks are deliberately rejected
 * until multimodal/tool execution is implemented.
 */
export function normalizeAnthropicRequest(body) {
  assertObject(body);
  rejectTools(body, "Anthropic");

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

  const input = formatConversation(body.messages, ["user", "assistant"], "Anthropic");
  const instruction = makeInstruction(systemParts, body.instruction);
  return {
    model,
    input,
    instruction,
    mode: validateMode(body.mode),
    stream,
    maxTokens: body.max_tokens,
    promptForUsage: instruction + "\n\n" + input
  };
}

/**
 * Token counts are estimates only. The upstream Agent I service does not return
 * OpenAI/Anthropic tokenizer usage metadata.
 */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4));
}
