import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createBackendServer } from "../src/server.js";

let app;
let baseUrl;
let db;
let lastGatewayPrompt = "";

before(async () => {
  db = openDatabase(":memory:");
  app = createBackendServer({
    db,
    apiToken: "compat-test-token",
    gateway: {
      async chat(prompt) {
        lastGatewayPrompt = prompt;
        if (prompt.includes("=== STOP: DO NOT CALL TOOLS ===")) return "I will answer without calling a tool.";
        if (prompt.includes("=== TEXT-ONLY RECOVERY ===")) return "I will answer without calling a tool.";
        if (prompt.includes("[tool_result id=call_")) return "OpenAI record 42 details confirmed.";
        if (prompt.includes("Record 42 was found.")) return "Record 42 details confirmed.";
        if (prompt.includes("fixture_lookup")) {
          return "<｜DSML｜ calls><｜DSML｜ invoke name=\"fixture_lookup\"><｜DSML｜ parameter name=\"id\" string=\"false\">42</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>";
        }
        return "Mock Agent I response";
      }
    }
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = "http://127.0.0.1:" + app.server.address().port;
});

after(async () => {
  if (app) await app.close();
  if (db) db.close();
});

test("OpenAI Chat Completions returns an OpenAI-shaped response", async () => {
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      messages: [
        { role: "system", content: "Answer clearly." },
        { role: "user", content: "Say hello." }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const data = await response.json();
  assert.equal(data.object, "chat.completion");
  assert.equal(data.model, "gpt-agent-v1");
  assert.equal(data.choices[0].message.role, "assistant");
  assert.equal(data.choices[0].message.content, "Mock Agent I response");
  assert.match(lastGatewayPrompt, /RESPONSE LANGUAGE POLICY/);
  assert.match(lastGatewayPrompt, /same natural language as the user's latest actual request/);
  assert.match(lastGatewayPrompt, /Do not switch to Japanese unless Japanese was explicitly requested/);
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.ok(data.usage.total_tokens >= data.usage.prompt_tokens);
  assert.ok(response.headers.get("x-agent-i-job-id"));
});

test("Anthropic Messages accepts x-api-key and returns a message object", async () => {
  const response = await fetch(baseUrl + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "compat-test-token",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-agent-v1",
      max_tokens: 512,
      system: "Be concise.",
      messages: [{ role: "user", content: "Say hello." }]
    })
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.type, "message");
  assert.equal(data.role, "assistant");
  assert.equal(data.model, "claude-agent-v1");
  assert.deepEqual(data.content, [{ type: "text", text: "Mock Agent I response" }]);
  assert.equal(data.stop_reason, "end_turn");
  assert.ok(data.usage.input_tokens > 0);
});

test("OpenAI streaming emits Chat Completion chunk frames and [DONE]", async () => {
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      stream: true,
      messages: [{ role: "user", content: "Say hello." }]
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const stream = await response.text();
  assert.match(stream, /"object":"chat\.completion\.chunk"/);
  assert.match(stream, /"content":"Mock Agent I response"/);
  assert.match(stream, /data: \[DONE\]/);
});

test("Anthropic streaming emits the Messages event sequence", async () => {
  const response = await fetch(baseUrl + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-agent-v1",
      max_tokens: 512,
      stream: true,
      messages: [{ role: "user", content: "Say hello." }]
    })
  });

  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /event: message_start/);
  assert.match(stream, /event: content_block_delta/);
  assert.match(stream, /Mock Agent I response/);
  assert.match(stream, /event: message_stop/);
});

test("OpenAI tools return validated tool_calls without executing them on the backend", async () => {
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      messages: [{ role: "user", content: "Look up record 42." }],
      tools: [{
        type: "function",
        function: {
          name: "fixture_lookup",
          description: "Look up a fixture record.",
          parameters: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
            additionalProperties: false
          }
        }
      }]
    })
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].finish_reason, "tool_calls");
  assert.equal(data.choices[0].message.content, null);
  assert.equal(data.choices[0].message.tool_calls.length, 1);
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "fixture_lookup");
  assert.deepEqual(JSON.parse(data.choices[0].message.tool_calls[0].function.arguments), { id: 42 });
  assert.match(lastGatewayPrompt, /### TOOLS/);
  assert.match(lastGatewayPrompt, /### LATEST USER MESSAGE/);
  assert.match(lastGatewayPrompt, /Look up record 42/);
  assert.doesNotMatch(lastGatewayPrompt, /SOURCE TEXT:/);
  assert.ok(lastGatewayPrompt.indexOf("### TOOLS") < lastGatewayPrompt.indexOf("### LATEST USER MESSAGE"));
  const savedJob = db.prepare("SELECT prompt_format FROM jobs WHERE id=?").get(response.headers.get("x-agent-i-job-id"));
  assert.equal(savedJob.prompt_format, "raw");
});

test("OpenAI tool prompts over the legacy 7 KB budget still use direct mode", async () => {
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      messages: [{ role: "user", content: "Look up record 42." }],
      tools: [{
        type: "function",
        function: {
          name: "fixture_lookup",
          description: "x".repeat(8000),
          parameters: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
            additionalProperties: false
          }
        }
      }]
    })
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].finish_reason, "tool_calls");
  const job = db.prepare("SELECT mode, prompt_format FROM jobs WHERE id=?")
    .get(response.headers.get("x-agent-i-job-id"));
  assert.equal(job.mode, "direct");
  assert.equal(job.prompt_format, "raw");
  assert.ok(lastGatewayPrompt.length > 7000);
});

test("OpenAI accepts tool-result messages and continues the conversation", async () => {
  const tool = {
    type: "function",
    function: {
      name: "fixture_lookup",
      description: "Look up a fixture record.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
        additionalProperties: false
      }
    }
  };
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      messages: [{ role: "user", content: "Look up record 42." }],
      tools: [tool]
    })
  });
  assert.equal(response.status, 200);
  const initial = await response.json();
  const call = initial.choices[0].message.tool_calls[0];

  const resumed = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      messages: [
        { role: "user", content: "Look up record 42." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: call.id,
            type: "function",
            function: call.function
          }]
        },
        {
          role: "tool",
          tool_call_id: call.id,
          content: "Record 42 was found."
        }
      ],
      tools: [tool]
    })
  });

  assert.equal(resumed.status, 200);
  const final = await resumed.json();
  assert.equal(final.choices[0].finish_reason, "stop");
  assert.equal(final.choices[0].message.content, "OpenAI record 42 details confirmed.");
  assert.match(lastGatewayPrompt, /=== LATEST TOOL RESULTS ===/);
  assert.ok(lastGatewayPrompt.includes("Record 42 was found."));
  assert.match(lastGatewayPrompt, /=== ORIGINAL USER REQUEST ===/);
});

test("tool_choice=none does not return tool calls", async () => {
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      messages: [{ role: "user", content: "Look up record 42." }],
      tools: [{
        type: "function",
        function: {
          name: "fixture_lookup",
          parameters: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
            additionalProperties: false
          }
        }
      }],
      tool_choice: "none"
    })
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(typeof data.choices[0].message.content, "string");
  assert.equal(data.choices[0].message.tool_calls, undefined);
});

test("Anthropic tools return tool_use blocks and accept tool_result messages", async () => {
  const initial = await fetch(baseUrl + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-agent-v1",
      max_tokens: 512,
      messages: [{ role: "user", content: "Look up record 42." }],
      tools: [{
        name: "fixture_lookup",
        description: "Look up a fixture record.",
        input_schema: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
          additionalProperties: false
        }
      }]
    })
  });

  assert.equal(initial.status, 200);
  const data = await initial.json();
  assert.equal(data.stop_reason, "tool_use");
  assert.equal(data.content[0].type, "tool_use");
  assert.match(data.content[0].id, /^toolu_/);
  assert.equal(data.content[0].name, "fixture_lookup");
  assert.deepEqual(data.content[0].input, { id: 42 });

  const resumed = await fetch(baseUrl + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-agent-v1",
      max_tokens: 512,
      messages: [
        { role: "user", content: "Look up record 42." },
        { role: "assistant", content: data.content },
        { role: "user", content: [{
          type: "tool_result",
          tool_use_id: data.content[0].id,
          content: "Record 42 was found."
        }] }
      ],
      tools: [{
        name: "fixture_lookup",
        description: "Look up a fixture record.",
        input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
      }]
    })
  });

  assert.equal(resumed.status, 200);
  const resumedData = await resumed.json();
  assert.equal(resumedData.stop_reason, "end_turn");
  assert.deepEqual(resumedData.content, [{ type: "text", text: "Record 42 details confirmed." }]);
  assert.match(lastGatewayPrompt, /=== LATEST TOOL RESULTS ===/);
  assert.ok(lastGatewayPrompt.includes("Record 42 was found."));
  assert.match(lastGatewayPrompt, /=== ORIGINAL USER REQUEST ===/);
});

test("OpenAI streaming emits tool_calls and the tool_calls finish reason", async () => {
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-agent-v1",
      stream: true,
      messages: [{ role: "user", content: "Look up record 42." }],
      tools: [{
        type: "function",
        function: {
          name: "fixture_lookup",
          parameters: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
            additionalProperties: false
          }
        }
      }]
    })
  });

  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /"tool_calls":\[\{"index":0/);
  assert.match(stream, /"name":"fixture_lookup"/);
  assert.match(stream, /"finish_reason":"tool_calls"/);
  assert.match(stream, /data: \[DONE\]/);
});

test("Anthropic streaming emits tool_use content blocks", async () => {
  const response = await fetch(baseUrl + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-agent-v1",
      max_tokens: 512,
      stream: true,
      messages: [{ role: "user", content: "Look up record 42." }],
      tools: [{
        name: "fixture_lookup",
        input_schema: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
          additionalProperties: false
        }
      }]
    })
  });

  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /"type":"tool_use"/);
  assert.match(stream, /"type":"input_json_delta"/);
  assert.match(stream, /"stop_reason":"tool_use"/);
  assert.match(stream, /event: message_stop/);
});

test("OpenAI model list advertises gpt-agent-v1", async () => {
  const response = await fetch(baseUrl + "/v1/models", {
    headers: { authorization: "Bearer compat-test-token" }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, "list");
  assert.equal(data.data[0].id, "gpt-agent-v1");
});

test("Anthropic model list advertises claude-agent-v1 in Anthropic format", async () => {
  const response = await fetch(baseUrl + "/v1/models", {
    headers: {
      "x-api-key": "compat-test-token",
      "anthropic-version": "2023-06-01"
    }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data[0].type, "model");
  assert.equal(data.data[0].id, "claude-agent-v1");
  assert.equal(data.data[0].display_name, "Claude Agent v1");
  assert.equal(data.data[0].lifecycle, "active");
  assert.equal(data.has_more, false);
});
