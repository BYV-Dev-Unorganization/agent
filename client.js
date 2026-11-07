import { randomBytes } from "node:crypto";

export function frcodeFor(source = "chattab_searchbar") {
  return "line_agenti_" + source;
}

export function frtypeFor(source = "chattab_searchbar") {
  return "line_" + source;
}

export function buildAgentIWebViewUrl({ source = "chattab_searchbar", query, baseUrl } = {}) {
  const url = new URL(baseUrl ?? "https://search.yahoo.co.jp/chat");
  url.searchParams.set("fr", frcodeFor(source));
  url.searchParams.set("frtype", frtypeFor(source));
  if (query !== undefined) url.searchParams.set("q", query);
  return url.toString();
}

const randomId32 = () => randomBytes(16).toString("hex");

export class AgentIClient {
  #options;
  #history;

  constructor(options = {}) {
    const lineVersion = options.lineVersion ?? "26.7.2";
    this.#history = Array.isArray(options.history) ? structuredClone(options.history) : [];
    this.#options = {
      cookie: options.cookie ?? "",
      lineVersion,
      source: options.source ?? "chattab_searchbar",
      endpoint: options.endpoint ?? "https://search-agent.yahoo.co.jp/v2/chat",
      fetch: options.fetch ?? globalThis.fetch,
      userAgent: options.userAgent ??
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Line/" + lineVersion + "/Agenti"
    };
    if (typeof this.#options.fetch !== "function") throw new Error("AgentIClient requires fetch");
  }

  async *chat(userText, extra = {}) {
    this.#history.push({
      id: randomId32(),
      role: "user",
      contents: [{ type: "text", text: userText }]
    });

    if (!this.#options.cookie) {
      this.#options.cookie = await AgentIClient.mintAnonymousCookies({
        fetch: this.#options.fetch,
        source: this.#options.source
      });
    }

    const body = {
      chats: this.#history,
      context: {
        agentMode: "multi",
        logid: extra.logid ?? randomId32(),
        qId: extra.qId ?? randomId32(),
        snc: true,
        frtype: frtypeFor(this.#options.source),
        frcode: frcodeFor(this.#options.source),
        requestType: "free_text",
        index: 0,
        yz: false,
        pdis: false
      },
      debug: {}
    };

    const response = await this.#options.fetch(this.#options.endpoint, {
      method: "POST",
      headers: {
        "user-agent": this.#options.userAgent,
        accept: "text/event-stream",
        "content-type": "application/json",
        pragma: "no-cache",
        "cache-control": "no-cache",
        "sec-fetch-site": "same-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "accept-language": "en",
        origin: "https://search.yahoo.co.jp",
        referer: "https://search.yahoo.co.jp/",
        priority: "u=3, i",
        cookie: this.#options.cookie
      },
      body: JSON.stringify(body),
      signal: extra.signal
    });

    if (!response.ok || !response.body) {
      throw new Error("Agent I: " + response.status + " " + response.statusText + " (no Yahoo session?)");
    }

    const answer = [];
    for await (const chunk of parseSseStream(response.body)) {
      if (chunk.text) answer.push(chunk.text);
      yield chunk;
    }
    if (answer.length) {
      this.#history.push({
        id: randomId32(),
        role: "assistant",
        contents: [{ type: "text", text: answer.join("") }]
      });
    }
  }

  static async mintAnonymousCookies({ fetch: fetchImpl = globalThis.fetch, source = "chattab_searchbar" } = {}) {
    const response = await fetchImpl(buildAgentIWebViewUrl({ source }), {
      method: "GET",
      redirect: "manual"
    });
    const headers = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
    return headers
      .flatMap((value) => value.split(/,(?=\s*\w+=)/))
      .map((value) => value.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  }

  reset() {
    this.#history = [];
  }

  get history() {
    return this.#history;
  }
}

async function* parseSseStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(raw);
        if (event) yield event;
      }
    }
    if (buffer.trim()) {
      const event = parseSseEvent(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(raw) {
  let event;
  const lines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) lines.push(line.slice(5).trim());
  }
  if (!lines.length) return null;
  const rawData = lines.join("\n");
  let data = rawData;
  if (rawData.startsWith("{") || rawData.startsWith("[")) {
    try { data = JSON.parse(rawData); } catch { /* keep raw event data */ }
  }
  return { event, data, text: extractText(data) };
}

function extractText(data) {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return null;
  if (data.type === "compositeMessage-delta" || data.type === "compositeMessage-end") {
    const message = data.value?.message;
    if (typeof message === "string") return message;
    if (typeof message?.text === "string") return message.text;
  }
  for (const key of ["text", "delta", "content"]) {
    if (typeof data[key] === "string") return data[key];
  }
  if (Array.isArray(data.contents)) {
    const parts = data.contents.filter((part) => typeof part?.text === "string").map((part) => part.text);
    if (parts.length) return parts.join("");
  }
  return null;
}
