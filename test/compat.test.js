import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createBackendServer } from "../src/server.js";

let app;
let baseUrl;
let db;

before(async () => {
  db = openDatabase(":memory:");
  app = createBackendServer({
    db,
    apiToken: "compat-test-token",
    gateway: {
      async chat() {
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
      model: "agent-i",
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
  assert.equal(data.model, "agent-i");
  assert.equal(data.choices[0].message.role, "assistant");
  assert.equal(data.choices[0].message.content, "Mock Agent I response");
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
      model: "agent-i",
      max_tokens: 512,
      system: "Be concise.",
      messages: [{ role: "user", content: "Say hello." }]
    })
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.type, "message");
  assert.equal(data.role, "assistant");
  assert.equal(data.model, "agent-i");
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
      model: "agent-i",
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
      model: "agent-i",
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

test("OpenAI tools are rejected with an OpenAI-shaped error until tools are implemented", async () => {
  const response = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer compat-test-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "agent-i",
      messages: [{ role: "user", content: "Search the web." }],
      tools: [{ type: "function", function: { name: "search" } }]
    })
  });

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error.type, "invalid_request_error");
  assert.match(data.error.message, /tools are not supported yet/i);
});

test("OpenAI model list includes the Agent I model alias", async () => {
  const response = await fetch(baseUrl + "/v1/models", {
    headers: { authorization: "Bearer compat-test-token" }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, "list");
  assert.equal(data.data[0].id, "agent-i");
});
