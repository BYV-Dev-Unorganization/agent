import { isDeepStrictEqual } from "node:util";

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOL_CALLS = 16;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertToolName(name, label) {
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
    throw new Error(label + " name must contain 1-64 letters, numbers, underscores, or hyphens");
  }
}

function normalizeSchema(schema, label) {
  if (!isPlainObject(schema)) throw new Error(label + " must be a JSON Schema object");
  if (schema.type !== undefined && schema.type !== "object" &&
      !(Array.isArray(schema.type) && schema.type.includes("object"))) {
    throw new Error(label + " must describe an object");
  }
  return schema;
}

export function normalizeOpenAITools(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tools must be an array");
  if (value.length > 64) throw new Error("OpenAI supports at most 64 tools per request");

  const names = new Set();
  return value.map((entry, index) => {
    if (!isPlainObject(entry) || entry.type !== "function" || !isPlainObject(entry.function)) {
      throw new Error("tools[" + index + "] must be a function tool");
    }
    const fn = entry.function;
    assertToolName(fn.name, "tools[" + index + "].function");
    if (names.has(fn.name)) throw new Error("Duplicate tool name: " + fn.name);
    names.add(fn.name);
    if (fn.description !== undefined && typeof fn.description !== "string") {
      throw new Error("tools[" + index + "].function.description must be a string");
    }
    const schema = normalizeSchema(fn.parameters ?? { type: "object", properties: {} },
      "tools[" + index + "].function.parameters");
    if (fn.strict !== undefined && typeof fn.strict !== "boolean") {
      throw new Error("tools[" + index + "].function.strict must be a boolean");
    }
    return {
      name: fn.name,
      description: fn.description ?? "",
      input_schema: schema
    };
  });
}

export function normalizeAnthropicTools(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tools must be an array");
  if (value.length > 128) throw new Error("Anthropic supports at most 128 tools per request");

  const names = new Set();
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error("tools[" + index + "] must be an object");
    assertToolName(entry.name, "tools[" + index + "]");
    if (names.has(entry.name)) throw new Error("Duplicate tool name: " + entry.name);
    names.add(entry.name);
    if (entry.description !== undefined && typeof entry.description !== "string") {
      throw new Error("tools[" + index + "].description must be a string");
    }
    const schema = normalizeSchema(entry.input_schema, "tools[" + index + "].input_schema");
    return {
      name: entry.name,
      description: entry.description ?? "",
      input_schema: schema
    };
  });
}

function findTool(tools, name) {
  return tools.find((tool) => tool.name === name);
}

export function normalizeOpenAIToolChoice(value, tools) {
  if (value === undefined) return { mode: tools.length ? "auto" : "none" };
  if (typeof value === "string") {
    if (!["none", "auto", "required"].includes(value)) {
      throw new Error("tool_choice must be none, auto, required, or a function selector");
    }
    if (value === "required" && !tools.length) {
      throw new Error("tool_choice=required needs at least one declared tool");
    }
    return { mode: value };
  }
  if (!isPlainObject(value) || value.type !== "function" ||
      !isPlainObject(value.function) || typeof value.function.name !== "string") {
    throw new Error("tool_choice object must select a function by name");
  }
  const name = value.function.name;
  if (!findTool(tools, name)) throw new Error("tool_choice references an undeclared tool: " + name);
  return { mode: "tool", name };
}

export function normalizeAnthropicToolChoice(value, tools) {
  if (value === undefined) return { mode: tools.length ? "auto" : "none" };
  if (!isPlainObject(value) || !["auto", "any", "tool", "none"].includes(value.type)) {
    throw new Error("tool_choice.type must be auto, any, tool, or none");
  }
  if ((value.type === "any" || value.type === "tool") && !tools.length) {
    throw new Error("tool_choice requires at least one declared tool");
  }
  if (value.type === "tool") {
    if (typeof value.name !== "string" || !findTool(tools, value.name)) {
      throw new Error("tool_choice references an undeclared tool");
    }
    return { mode: "tool", name: value.name };
  }
  return { mode: value.type };
}

export function buildToolInstruction(tools, choice) {
  if (!tools.length || choice.mode === "none") {
    return [
      "TOOL CALL POLICY:",
      "Do not call tools. Do not emit DSML markup. Answer the user in plain text."
    ].join("\n");
  }

  const lines = [
    "TOOL CALLING PROTOCOL:",
    "You may request tools only from the exact list below. Tool execution is performed by the API client, not by you.",
    "When a tool is needed, return a DSML calls block and nothing outside that block.",
    "When no tool is needed and tool_choice is auto, answer normally in plain text.",
    "Do not invent tool names or arguments. Follow each input schema and include every required property.",
    "",
    "DECLARED TOOLS:"
  ];

  for (const tool of tools) {
    lines.push("- " + tool.name + ": " + (tool.description || "No description supplied."));
    lines.push("  input_schema: " + JSON.stringify(tool.input_schema));
  }

  lines.push("");
  lines.push("REQUIRED DSML FORMAT:");
  lines.push("<｜DSML｜ calls>");
  lines.push("<｜DSML｜ invoke name=\"TOOL_NAME\">");
  lines.push("<｜DSML｜ parameter name=\"ARGUMENT_NAME\" string=\"true\">raw string value</｜DSML｜ parameter>");
  lines.push("<｜DSML｜ parameter name=\"ANOTHER_ARGUMENT\" string=\"false\">valid JSON value</｜DSML｜ parameter>");
  lines.push("</｜DSML｜ invoke>");
  lines.push("</｜DSML｜ calls>");
  lines.push("");
  lines.push("Use one invoke block per tool call. Multiple invokes may appear in the same calls block.");
  lines.push("For string arguments, use string=\"true\" and write the raw value without JSON quotes.");
  lines.push("For numbers, booleans, null, arrays, and objects, use string=\"false\" and write valid JSON.");
  lines.push("Use the exact schema property names. Do not repeat a parameter name.");
  lines.push("Do not put Markdown, explanations, or other text inside the calls block.");

  if (choice.mode === "required" || choice.mode === "any") {
    lines.push("TOOL CHOICE: at least one tool call is required for this turn.");
  } else if (choice.mode === "tool") {
    lines.push("TOOL CHOICE: call the tool named \"" + choice.name + "\". Do not call a different tool.");
  } else {
    lines.push("TOOL CHOICE: auto. Call a tool only when it is needed to complete the user's request.");
  }

  return lines.join("\n");
}

function renderToolPromptMessage(message) {
  const role = message.role === "tool" ? "TOOL RESULT" : String(message.role || "unknown").toUpperCase();
  return "[" + role + "]\n" + String(message.content ?? "");
}

function summarizeToolParameters(schema = {}) {
  const properties = schema.properties && typeof schema.properties === "object"
    ? Object.entries(schema.properties)
    : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return properties.map(([name, definition]) => {
    const type = Array.isArray(definition?.type)
      ? definition.type.join("|")
      : definition?.type || "any";
    const description = typeof definition?.description === "string" && definition.description.trim()
      ? " (" + definition.description.trim() + ")"
      : "";
    return name + (required.has(name) ? "*" : "") + ": " + type + description;
  }).join("; ") || "no arguments";
}

/**
 * Build the prompt in the same order used by deepseek-super:
 * system -> conversation history -> tools -> latest user/tool-result turn.
 * The returned text is sent directly to Agent I without the generic
 * source-text wrapper used by ordinary long-document requests.
 */
export function buildToolCallingPrompt({
  systemPrompt = "",
  userInstruction = "",
  messages = [],
  tools = [],
  toolChoice = { mode: "auto" },
  recoveryReason = "",
  forceTextOnly = false
} = {}) {
  const parts = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim()) {
    parts.push("### SYSTEM\n" + systemPrompt.trim());
  }
  if (typeof userInstruction === "string" && userInstruction.trim()) {
    parts.push("### ADDITIONAL INSTRUCTIONS\n" + userInstruction.trim());
  }

  const latest = messages[messages.length - 1] || { role: "user", content: "" };
  const history = messages.slice(0, -1);
  const choiceMode = forceTextOnly ? "none" : (toolChoice?.mode || "auto");
  if (history.length) {
    parts.push("### CONVERSATION HISTORY\n" +
      history.map(renderToolPromptMessage).join("\n\n"));
  }

  if (tools.length && choiceMode !== "none") {
    const lines = [
      "You have access to the tools listed below. These are the only tools available for this request.",
      "You do not execute tools yourself. Emit tool requests in DSML; the API client executes them and sends their results back in a later message.",
      "",
      ...tools.flatMap((tool) => [
        "- " + tool.name + "(" + summarizeToolParameters(tool.input_schema) + "): " +
          (tool.description || "No description supplied."),
        "  input_schema: " + JSON.stringify(tool.input_schema)
      ]),
      "",
      "MANDATORY RULES:",
      choiceMode === "none"
        ? "1. Tool calling is disabled for this turn. Do not call any tool."
        : "1. If the task requires information or an action that one of the listed tools can provide, you MUST use the appropriate tool. Do not guess, fabricate results, or substitute a manual answer.",
      "2. If tool results already received are sufficient to complete the task, provide the final answer without another tool call. Otherwise, continue with the next appropriate tool.",
      "3. Use the exact gateway DSML markup below. Do not use JSON tool-call wrappers, Markdown fences, or legacy <TOOL_CALL> tags.",
      "4. Emit exactly ONE outer calls block for the whole assistant tool response, with one invoke block per requested tool. Do not repeat the calls wrapper.",
      "5. For string arguments, set string=\"true\" and write the raw string value without JSON quoting or escaping.",
      "6. For numbers, booleans, null, arrays, and objects, set string=\"false\" and write the value as valid JSON.",
      "7. Use each parameter name exactly as declared in the selected tool schema. Do not duplicate parameter names or invent tools or arguments.",
      "8. Do NOT write anything outside the DSML calls block when calling tools.",
      choiceMode === "required" || choiceMode === "any" || choiceMode === "tool"
        ? "9. Follow the forced tool choice above even if you could otherwise answer directly."
        : "9. Use plain text only when no tool is needed or when the task is complete.",
      "",
      "REQUIRED DSML FORMAT (format example only; replace all placeholders):",
      "<｜DSML｜ calls>",
      "<｜DSML｜ invoke name=\"TOOL_NAME\">",
      "<｜DSML｜ parameter name=\"STRING_ARGUMENT\" string=\"true\">RAW_STRING_VALUE</｜DSML｜ parameter>",
      "<｜DSML｜ parameter name=\"NON_STRING_ARGUMENT\" string=\"false\">VALID_JSON_VALUE</｜DSML｜ parameter>",
      "</｜DSML｜ invoke>",
      "</｜DSML｜ calls>"
    ];

    parts.push("### TOOLS\n" + lines.join("\n"));
  } else if (tools.length && choiceMode === "none") {
    parts.push("### TOOL CALL POLICY\nTool calling is disabled for this turn. Do not call any tool and do not emit DSML or tool-call markup. Answer in plain text using only the available conversation.");
  }

  const latestText = renderToolPromptMessage(latest);
  const latestIsToolResult = ["user", "tool"].includes(latest.role) && /\[tool_result id=/.test(String(latest.content ?? ""));
  if (latestIsToolResult) {
    parts.push("=== LATEST TOOL RESULTS ===\n" + latestText);
    const originalRequest = messages.find((message) =>
      message.role === "user" && !/\[tool_result id=/.test(String(message.content ?? ""))
    );
    if (originalRequest) {
      parts.push("=== ORIGINAL USER REQUEST ===\n" + renderToolPromptMessage(originalRequest));
    }
    parts.push([
      "=== INSTRUCTIONS AFTER TOOL RESULTS ===",
      "Base claims on tool results that were actually received. Do not claim success unless a tool result confirms it.",
      "If the task is complete, provide the final answer without tool-call tags.",
      "If the received results are insufficient, call the next necessary tool using exactly one DSML calls block.",
      "If a tool failed, report the actual error returned by that tool."
    ].join("\n"));
  } else {
    parts.push("### LATEST USER MESSAGE\n" + latestText);
    parts.push("Respond as the assistant. If a tool is needed, output only one gateway DSML calls block using the invoke and parameter tags defined above. Do not include prose or Markdown outside that block.");
  }

  if (forceTextOnly) {
    parts.push([
      "=== TEXT-ONLY RECOVERY ===",
      "A repeated tool call was detected. Do not call any tool again in this turn.",
      "Do not emit DSML markup. Give the best possible plain-text answer using only the conversation and tool results already available."
    ].join("\n"));
  } else if (recoveryReason) {
    parts.push([
      "=== TOOL CALL RECOVERY ===",
      "Your previous response did not contain a valid DSML tool call or did not satisfy the declared schema.",
      "Correct the issue below and rebuild the necessary tool call from scratch.",
      "Output exactly one valid DSML calls block when a tool is required. Do not answer in plain text instead.",
      "Use only the declared tool names and schema-valid arguments.",
      "Validation issue: " + recoveryReason
    ].join("\n"));
  }

  const prompt = parts.join("\n\n");
  if (forceTextOnly || choiceMode === "none") {
    return [
      "=== STOP: DO NOT CALL TOOLS ===",
      "Using all information already available in the conversation, answer the user now in plain text.",
      "Do not emit DSML calls/invoke/parameter tags, legacy <TOOL_CALL> tags, or tool-call JSON.",
      prompt
    ].join("\n\n");
  }
  if (choiceMode === "required" || choiceMode === "any") {
    return [
      "[REQUIRED: Call at least one tool from the declared list NOW. Do not answer in plain text instead of calling a tool.]",
      prompt
    ].join("\n\n");
  }
  if (choiceMode === "tool") {
    return [
      "[REQUIRED: Call the tool \"" + toolChoice.name + "\" NOW. Respond only with one DSML calls block containing an invoke for that exact tool.]",
      prompt
    ].join("\n\n");
  }
  return prompt;
}

function readAttribute(attributes, name) {
  const matcher = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = matcher.exec(attributes)) !== null) {
    if (match[1].toLowerCase() === name.toLowerCase()) {
      return match[3] !== undefined ? match[3] : match[4];
    }
  }
  return null;
}

const OUTER_BLOCK_RE =
  /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>([\s\S]*?)<\s*\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>/gi;
const INVOKE_RE =
  /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke\b([^>]*)>([\s\S]*?)<\s*\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke\s*>/gi;
const PARAMETER_RE =
  /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*parameter\s*>/gi;
const ANY_DSML_RE =
  /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b[^>]*>/gi;

function parseInvokeBlocks(raw) {
  const calls = [];
  const errors = [];
  const matcher = new RegExp(INVOKE_RE.source, "gi");
  let match;
  let consumed = 0;

  while ((match = matcher.exec(raw)) !== null) {
    if (raw.slice(consumed, match.index).trim()) {
      errors.push("Unexpected content between DSML invoke blocks.");
    }
    consumed = matcher.lastIndex;
    const name = readAttribute(match[1], "name");
    if (!name || !name.trim()) {
      errors.push("DSML invoke is missing a valid name attribute.");
      continue;
    }

    const body = match[2];
    const parameterMatcher = new RegExp(PARAMETER_RE.source, "gi");
    const input = Object.create(null);
    let parameterMatch;
    let parameterConsumed = 0;
    let valid = true;

    while ((parameterMatch = parameterMatcher.exec(body)) !== null) {
      if (body.slice(parameterConsumed, parameterMatch.index).trim()) {
        errors.push("Unexpected content inside DSML invoke for tool \"" + name + "\".");
        valid = false;
      }
      parameterConsumed = parameterMatcher.lastIndex;
      const parameterName = readAttribute(parameterMatch[1], "name");
      const stringFlag = readAttribute(parameterMatch[1], "string");
      if (!parameterName || !parameterName.trim()) {
        errors.push("DSML parameter is missing a valid name for tool \"" + name + "\".");
        valid = false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(input, parameterName)) {
        errors.push("Duplicate DSML parameter \"" + parameterName + "\" for tool \"" + name + "\".");
        valid = false;
        continue;
      }
      if (stringFlag !== "true" && stringFlag !== "false") {
        errors.push("DSML parameter \"" + parameterName + "\" must declare string=\"true\" or string=\"false\".");
        valid = false;
        continue;
      }
      const rawValue = parameterMatch[2];
      if (stringFlag === "true") {
        Object.defineProperty(input, parameterName, {
          value: rawValue,
          enumerable: true,
          configurable: true,
          writable: true
        });
      } else {
        try {
          Object.defineProperty(input, parameterName, {
            value: JSON.parse(rawValue.trim()),
            enumerable: true,
            configurable: true,
            writable: true
          });
        } catch {
          errors.push("DSML parameter \"" + parameterName + "\" contains invalid JSON.");
          valid = false;
        }
      }
    }

    if (body.slice(parameterConsumed).trim()) {
      errors.push("Unexpected trailing content inside DSML invoke for tool \"" + name + "\".");
      valid = false;
    }
    if (valid) calls.push({ name, input });
  }

  if (!calls.length && !errors.length) errors.push("DSML calls block did not contain a complete invoke block.");
  if (raw.slice(consumed).trim()) errors.push("Unexpected trailing content in DSML calls block.");
  return { calls, errors };
}

export function parseDsmlToolCalls(value) {
  const source = typeof value === "string" ? value : "";
  const sawDsmlMarkup = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i.test(source);
  const sawLegacyMarkup = /<\s*TOOL_CALL\s*>/i.test(source);
  const sawToolMarkup = sawDsmlMarkup || sawLegacyMarkup;
  const calls = [];
  const errors = [];
  let completeBlocks = 0;

  const text = source.replace(new RegExp(OUTER_BLOCK_RE.source, "gi"), (_whole, payload) => {
    completeBlocks += 1;
    const parsed = parseInvokeBlocks(payload);
    calls.push(...parsed.calls);
    errors.push(...parsed.errors);
    return "";
  });

  if (sawLegacyMarkup) {
    errors.push("Legacy <TOOL_CALL> markup is unsupported; use DSML calls/invoke/parameter tags.");
  }
  if (sawDsmlMarkup && completeBlocks === 0) {
    errors.push("DSML markup was present but no complete calls block could be parsed.");
  }
  if (completeBlocks > 0 && /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i.test(text)) {
    errors.push("Unclosed or malformed DSML markup remains outside the parsed calls block.");
  }

  const cleanedText = text.replace(ANY_DSML_RE, "").trim();
  return { calls, text: cleanedText, errors, sawToolMarkup, completeBlocks };
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "object": return isPlainObject(value);
      case "array": return Array.isArray(value);
      case "string": return typeof value === "string";
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "boolean": return typeof value === "boolean";
      case "null": return value === null;
      default: return false;
    }
  });
}

function resolveLocalReference(root, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) return null;
  let parts;
  try {
    parts = reference.slice(2).split("/").map((part) =>
      decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))
    );
  } catch {
    return null;
  }
  let current = root;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
      return null;
    }
    current = current[part];
  }
  return current === null || current === undefined ? null : current;
}

function compileSafePattern(pattern, label) {
  if (pattern.length > 128) throw new Error(label + " exceeds the 128-character safe pattern limit.");
  // Reject quantified groups containing alternation or other quantifiers to avoid common
  // catastrophic-backtracking patterns in untrusted client-supplied schemas.
  if (/\((?:\?:)?[^)]*[|*+?{][^)]*\)[*+?{]/.test(pattern)) {
    throw new Error(label + " uses an unsafe nested or quantified-group pattern.");
  }
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(label + " has an invalid regular expression.");
  }
}

function validateAgainstSchema(value, schema, path, rootSchema, depth = 0) {
  if (schema === true) return null;
  if (schema === false) return path + " is not allowed by its schema.";
  if (!isPlainObject(schema)) return path + " has an invalid schema.";
  if (depth > 32) return path + " exceeds the maximum schema reference depth.";

  if (schema.$ref !== undefined) {
    const target = resolveLocalReference(rootSchema, schema.$ref);
    if (target === null) return path + " uses an unresolved or unsupported $ref.";
    const error = validateAgainstSchema(value, target, path, rootSchema, depth + 1);
    if (error) return error;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") &&
      !isDeepStrictEqual(value, schema.const)) {
    return path + " must equal the declared constant.";
  }
  if (Array.isArray(schema.enum) &&
      !schema.enum.some((item) => isDeepStrictEqual(value, item))) {
    return path + " must match one of the allowed enum values.";
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return path + " must be of type " + (Array.isArray(schema.type) ? schema.type.join("|") : schema.type) + ".";
  }

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const error = validateAgainstSchema(value, part, path, rootSchema, depth + 1);
      if (error) return error;
    }
  }
  if (Array.isArray(schema.anyOf) &&
      !schema.anyOf.some((part) => validateAgainstSchema(value, part, path, rootSchema, depth + 1) === null)) {
    return path + " does not match any allowed schema.";
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((part) =>
      validateAgainstSchema(value, part, path, rootSchema, depth + 1) === null
    ).length;
    if (matches !== 1) return path + " must match exactly one allowed schema.";
  }
  if (schema.not && validateAgainstSchema(value, schema.not, path, rootSchema, depth + 1) === null) {
    return path + " matches a schema that is not allowed.";
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (Number.isInteger(schema.minProperties) && Object.keys(value).length < schema.minProperties) {
      return path + " must contain at least " + schema.minProperties + " properties.";
    }
    if (Number.isInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) {
      return path + " must contain at most " + schema.maxProperties + " properties.";
    }
    for (const key of required) {
      if (typeof key !== "string") return path + " has an invalid required declaration.";
      if (!Object.prototype.hasOwnProperty.call(value, key)) return path + "." + key + " is required.";
    }
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const error = validateAgainstSchema(value[key], properties[key], path + "." + key, rootSchema, depth + 1);
        if (error) return error;
        continue;
      }
      let matchedPattern = false;
      for (const [pattern, childSchema] of Object.entries(patternProperties)) {
        let matcher;
        try { matcher = compileSafePattern(pattern, path + " patternProperties"); }
        catch (error) { return error.message; }
        if (matcher.test(key)) {
          matchedPattern = true;
          const error = validateAgainstSchema(value[key], childSchema, path + "." + key, rootSchema, depth + 1);
          if (error) return error;
        }
      }
      if (!matchedPattern && schema.additionalProperties === false) {
        return path + "." + key + " is not allowed.";
      }
      if (!matchedPattern && isPlainObject(schema.additionalProperties)) {
        const error = validateAgainstSchema(value[key], schema.additionalProperties, path + "." + key, rootSchema, depth + 1);
        if (error) return error;
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return path + " must contain at least " + schema.minItems + " item(s).";
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return path + " must contain at most " + schema.maxItems + " item(s).";
    }
    if (schema.uniqueItems === true) {
      if (value.length > 1000) return path + " has too many items for safe uniqueItems validation.";
      for (let index = 0; index < value.length; index += 1) {
        for (let other = index + 1; other < value.length; other += 1) {
          if (isDeepStrictEqual(value[index], value[other])) {
            return path + " must contain unique items.";
          }
        }
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      for (let index = 0; index < Math.min(value.length, schema.prefixItems.length); index += 1) {
        const error = validateAgainstSchema(value[index], schema.prefixItems[index], path + "[" + index + "]", rootSchema, depth + 1);
        if (error) return error;
      }
    }
    if (schema.items && !Array.isArray(schema.items)) {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let index = start; index < value.length; index += 1) {
        const error = validateAgainstSchema(value[index], schema.items, path + "[" + index + "]", rootSchema, depth + 1);
        if (error) return error;
      }
    }
  }

  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) {
      return path + " must be at least " + schema.minLength + " character(s).";
    }
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) {
      return path + " must be at most " + schema.maxLength + " character(s).";
    }
    if (typeof schema.pattern === "string") {
      if (value.length > 4096) return path + " is too long for safe pattern validation.";
      let matcher;
      try { matcher = compileSafePattern(schema.pattern, path + " pattern"); }
      catch (error) { return error.message; }
      if (!matcher.test(value)) return path + " does not match the required pattern.";
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return path + " must be at least " + schema.minimum + ".";
    if (typeof schema.maximum === "number" && value > schema.maximum) return path + " must be at most " + schema.maximum + ".";
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return path + " must be greater than " + schema.exclusiveMinimum + ".";
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return path + " must be less than " + schema.exclusiveMaximum + ".";
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-10) return path + " must be a multiple of " + schema.multipleOf + ".";
    }
  }

  return null;
}

export function validateToolCalls(calls, tools, choice = { mode: "auto" }) {
  if (!Array.isArray(calls) || calls.length === 0) {
    if (["required", "any", "tool"].includes(choice.mode)) {
      return { valid: false, error: "At least one tool call is required by tool_choice." };
    }
    return { valid: true, error: null };
  }
  if (calls.length > MAX_TOOL_CALLS) {
    return { valid: false, error: "The response contains more than " + MAX_TOOL_CALLS + " tool calls." };
  }
  if (choice.mode === "none") return { valid: false, error: "Tool calls are disabled by tool_choice=none." };

  const specs = new Map(tools.map((tool) => [tool.name, tool]));
  for (const call of calls) {
    if (!call || typeof call.name !== "string" || !call.name) {
      return { valid: false, error: "A tool call is missing a valid name." };
    }
    const spec = specs.get(call.name);
    if (!spec) return { valid: false, error: "Tool name \"" + call.name + "\" was not declared in this request." };
    if (choice.mode === "tool" && call.name !== choice.name) {
      return { valid: false, error: "tool_choice requires the tool \"" + choice.name + "\"." };
    }
    if (!isPlainObject(call.input)) {
      return { valid: false, error: "Arguments for tool \"" + call.name + "\" must be a JSON object." };
    }
    const error = validateAgainstSchema(call.input, spec.input_schema, call.name + ".arguments", spec.input_schema);
    if (error) return { valid: false, error };
  }

  if (["required", "any", "tool"].includes(choice.mode) && calls.length === 0) {
    return { valid: false, error: "At least one tool call is required by tool_choice." };
  }
  return { valid: true, error: null };
}

export function hasRepeatedToolCallLoop(calls, previousTurns) {
  if (!Array.isArray(previousTurns) || previousTurns.length < 2) return false;
  const signature = (call) => call.name + "|" + JSON.stringify(call.input ?? {});
  const batchSignature = (batch) => Array.isArray(batch)
    ? batch.map(signature).sort().join("\n")
    : "";
  const last = batchSignature(previousTurns[previousTurns.length - 1]);
  const beforeLast = batchSignature(previousTurns[previousTurns.length - 2]);
  if (!last || last !== beforeLast) return false;
  return batchSignature(calls) === last;
}
