import test from "node:test";
import assert from "node:assert/strict";
import { AgentIClient, buildAgentIWebViewUrl, frcodeFor, frtypeFor } from "../client.js";

function mockFetch(events) {
  return async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const item of events) controller.enqueue(encoder.encode(item));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

test("source identifiers and WebView URL match expected values", () => {
  assert.equal(frcodeFor("chattab_searchbar"), "line_agenti_chattab_searchbar");
  assert.equal(frtypeFor("hometab_searchbar"), "line_hometab_searchbar");
  const url = new URL(buildAgentIWebViewUrl({ source: "chattab_searchbar", query: "こんにちは" }));
  assert.equal(url.origin + url.pathname, "https://search.yahoo.co.jp/chat");
  assert.equal(url.searchParams.get("q"), "こんにちは");
});

test("client parses SSE text and stores the conversation turn", async () => {
  const client = new AgentIClient({
    cookie: "B=test",
    fetch: mockFetch(['event: message\ndata: {"text":"Hello"}\n\n', 'event: done\ndata: {}\n\n'])
  });
  const chunks = [];
  for await (const chunk of client.chat("Hi")) if (chunk.text) chunks.push(chunk.text);
  assert.equal(chunks.join(""), "Hello");
  assert.equal(client.history.length, 2);
  assert.equal(client.history[0].contents[0].text, "Hi");
  assert.equal(client.history[1].contents[0].text, "Hello");
});

test("client parses Yahoo composite message payloads", async () => {
  const client = new AgentIClient({
    cookie: "B=test",
    fetch: mockFetch(['data: {"type":"compositeMessage-delta","value":{"message":{"text":"nested"}}}\n\n'])
  });
  const chunks = [];
  for await (const chunk of client.chat("Hi")) chunks.push(chunk);
  assert.equal(chunks[0].text, "nested");
});

test("Yahoo chat requests send an English Accept-Language header", async () => {
  let capturedUrl;
  let capturedInit;
  const client = new AgentIClient({
    cookie: "B=test",
    fetch: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response('data: {"text":"Hello"}\\n\\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });

  for await (const _chunk of client.chat("Hi")) {
    // Consume the response stream.
  }

  assert.equal(capturedUrl, "https://search-agent.yahoo.co.jp/v2/chat");
  assert.equal(capturedInit.headers["accept-language"], "en");
});
