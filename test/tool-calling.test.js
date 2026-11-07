import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOpenAITools,
  buildToolCallingPrompt,
  normalizeOpenAIToolChoice,
  parseDsmlToolCalls,
  validateToolCalls,
  hasRepeatedToolCallLoop
} from "../src/tool-calling.js";

const tools = normalizeOpenAITools([{
  type: "function",
  function: {
    name: "lookup_record",
    description: "Look up a record.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        include_history: { type: "boolean" }
      },
      required: ["id"],
      additionalProperties: false
    }
  }
}]);

test("parses DSML calls with string and JSON parameters", () => {
  const parsed = parseDsmlToolCalls(
    "<｜DSML｜ calls>" +
    "<｜DSML｜ invoke name=\"lookup_record\">" +
    "<｜DSML｜ parameter name=\"id\" string=\"false\">42</｜DSML｜ parameter>" +
    "<｜DSML｜ parameter name=\"include_history\" string=\"false\">true</｜DSML｜ parameter>" +
    "</｜DSML｜ invoke></｜DSML｜ calls>"
  );

  assert.equal(parsed.sawToolMarkup, true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, "lookup_record");
  assert.deepEqual({ ...parsed.calls[0].input }, { id: 42, include_history: true });
});

test("parses multiple tool invocations in one calls block", () => {
  const parsed = parseDsmlToolCalls(
    "<｜DSML｜ calls>" +
    "<｜DSML｜ invoke name=\"lookup_record\"><｜DSML｜ parameter name=\"id\" string=\"false\">1</｜DSML｜ parameter></｜DSML｜ invoke>" +
    "<｜DSML｜ invoke name=\"lookup_record\"><｜DSML｜ parameter name=\"id\" string=\"false\">2</｜DSML｜ parameter></｜DSML｜ invoke>" +
    "</｜DSML｜ calls>"
  );

  assert.equal(parsed.calls.length, 2);
  assert.deepEqual(parsed.errors, []);
});

test("leaves ordinary assistant text unchanged when no DSML is present", () => {
  const parsed = parseDsmlToolCalls("The record was found.");
  assert.equal(parsed.sawToolMarkup, false);
  assert.equal(parsed.text, "The record was found.");
  assert.deepEqual(parsed.calls, []);
  assert.deepEqual(parsed.errors, []);
});

test("rejects incomplete DSML and invalid parameter JSON", () => {
  const incomplete = parseDsmlToolCalls("<｜DSML｜ calls><｜DSML｜ invoke name=\"lookup_record\">");
  assert.equal(incomplete.sawToolMarkup, true);
  assert.ok(incomplete.errors.length > 0);

  const invalidJson = parseDsmlToolCalls(
    "<｜DSML｜ calls><｜DSML｜ invoke name=\"lookup_record\">" +
    "<｜DSML｜ parameter name=\"id\" string=\"false\">not-json</｜DSML｜ parameter>" +
    "</｜DSML｜ invoke></｜DSML｜ calls>"
  );
  assert.ok(invalidJson.errors.length > 0);
});

test("validates required fields, types, and additionalProperties", () => {
  assert.deepEqual(validateToolCalls(
    [{ name: "lookup_record", input: { id: 42 } }],
    tools,
    { mode: "auto" }
  ), { valid: true, error: null });

  const missing = validateToolCalls(
    [{ name: "lookup_record", input: {} }],
    tools,
    { mode: "auto" }
  );
  assert.equal(missing.valid, false);
  assert.match(missing.error, /id is required/i);

  const extra = validateToolCalls(
    [{ name: "lookup_record", input: { id: 42, shell: "not executed" } }],
    tools,
    { mode: "auto" }
  );
  assert.equal(extra.valid, false);
  assert.match(extra.error, /not allowed/i);
});

test("rejects unsafe client-supplied regular expression patterns", () => {
  const unsafeTools = normalizeOpenAITools([{
    type: "function",
    function: {
      name: "validate_code",
      parameters: {
        type: "object",
        properties: { code: { type: "string", pattern: "^(a+)+$" } },
        required: ["code"]
      }
    }
  }]);
  const result = validateToolCalls(
    [{ name: "validate_code", input: { code: "aaaaaaaa!" } }],
    unsafeTools,
    { mode: "auto" }
  );
  assert.equal(result.valid, false);
  assert.match(result.error, /unsafe nested or quantified-group pattern/i);
});

test("enforces required and named tool choices", () => {
  const required = normalizeOpenAIToolChoice("required", tools);
  assert.equal(validateToolCalls([], tools, required).valid, false);
  assert.equal(validateToolCalls(
    [{ name: "lookup_record", input: { id: 7 } }],
    tools,
    required
  ).valid, true);

  const selected = normalizeOpenAIToolChoice({
    type: "function",
    function: { name: "lookup_record" }
  }, tools);
  assert.equal(validateToolCalls(
    [{ name: "another_tool", input: {} }],
    tools,
    selected
  ).valid, false);
});

test("detects a tool call repeated over three consecutive assistant turns", () => {
  const repeated = [{ name: "lookup_record", input: { id: 9 } }];
  assert.equal(hasRepeatedToolCallLoop(repeated, [repeated, repeated]), true);
  assert.equal(hasRepeatedToolCallLoop(repeated, [repeated, [{ name: "lookup_record", input: { id: 10 } }]]), false);
});


test("builds a DeepSeek-style tool prompt with tools before the latest user message", () => {
  const prompt = buildToolCallingPrompt({
    systemPrompt: "Follow the system policy.",
    userInstruction: "Keep the answer concise.",
    messages: [
      { role: "user", content: "Previous request." },
      { role: "assistant", content: "Previous answer." },
      { role: "user", content: "Look up record 42." }
    ],
    tools,
    toolChoice: { mode: "tool", name: "lookup_record" }
  });

  assert.ok(prompt.indexOf("### SYSTEM") < prompt.indexOf("### CONVERSATION HISTORY"));
  assert.ok(prompt.indexOf("### CONVERSATION HISTORY") < prompt.indexOf("### TOOLS"));
  assert.ok(prompt.indexOf("### TOOLS") < prompt.indexOf("### LATEST USER MESSAGE"));
  assert.ok(prompt.includes("lookup_record(id*: integer; include_history: boolean)"));
  assert.ok(prompt.startsWith('[REQUIRED: Call the tool "lookup_record" NOW.'));

  assert.match(prompt, /<｜DSML｜ calls>/);
  assert.match(prompt, /<｜DSML｜ invoke name="TOOL_NAME">/);
  assert.ok(prompt.includes("Look up record 42."));
  assert.doesNotMatch(prompt, /SOURCE TEXT:/);
});

test("builds a tool-result continuation prompt with original task context", () => {
  const prompt = buildToolCallingPrompt({
    messages: [
      { role: "user", content: "Look up record 42." },
      { role: "assistant", content: "[assistant tool_use id=toolu_123 name=lookup_record]\\n{\\"id\\":42}" },
      { role: "user", content: "[tool_result id=toolu_123]\\nRecord 42 was found." }
    ],
    tools,
    toolChoice: { mode: "auto" }
  });

  assert.match(prompt, /=== LATEST TOOL RESULTS ===/);
  assert.match(prompt, /=== ORIGINAL USER REQUEST ===/);
  assert.ok(prompt.includes("Record 42 was found."));
  assert.match(prompt, /If the task is complete, provide the final answer/);
});
