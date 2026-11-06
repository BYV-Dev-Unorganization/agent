import { AgentIClient } from "../client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timeoutFetch(timeoutMs) {
  return (url, init = {}) => {
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
    return globalThis.fetch(url, { ...init, signal });
  };
}

function statusFromError(error) {
  const match = String(error?.message ?? error).match(/Agent I: ([0-9]{3})/i);
  return match ? Number(match[1]) : null;
}

/** One shared gateway serializes requests and reuses the anonymous Yahoo session cookie. */
export class AgentGateway {
  #source;
  #lineVersion;
  #fetch;
  #minDelay;
  #maxAttempts;
  #cookie = null;
  #cookiePromise = null;
  #lastStart = 0;
  #chain = Promise.resolve();

  constructor(options = {}) {
    this.#source = options.source ?? process.env.AGENT_SOURCE ?? "chattab_searchbar";
    this.#lineVersion = options.lineVersion ?? process.env.LINE_VERSION ?? "26.7.2";
    const timeoutMs = Number(options.timeoutMs ?? process.env.AGENT_TIMEOUT_MS ?? 120000);
    this.#fetch = options.fetch ?? timeoutFetch(timeoutMs);
    this.#minDelay = Number(options.minDelayMs ?? process.env.AGENT_MIN_DELAY_MS ?? 1500);
    this.#maxAttempts = Number(options.maxAttempts ?? process.env.AGENT_MAX_ATTEMPTS ?? 3);
  }

  async #getCookie(refresh = false) {
    if (refresh) this.#cookie = null;
    if (this.#cookie) return this.#cookie;
    if (!this.#cookiePromise) {
      this.#cookiePromise = AgentIClient.mintAnonymousCookies({
        fetch: this.#fetch,
        source: this.#source
      }).then((cookie) => {
        this.#cookie = cookie || "";
        return this.#cookie;
      }).finally(() => { this.#cookiePromise = null; });
    }
    return this.#cookiePromise;
  }

  async #throttle() {
    const task = this.#chain.then(async () => {
      const delay = Math.max(0, this.#minDelay - (Date.now() - this.#lastStart));
      if (delay) await sleep(delay);
      this.#lastStart = Date.now();
    });
    this.#chain = task.catch(() => {});
    await task;
  }

  async chat(prompt, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await this.#throttle();
      try {
        const cookie = await this.#getCookie(attempt > 1 && statusFromError(lastError) === 401);
        const client = new AgentIClient({
          cookie,
          source: this.#source,
          lineVersion: this.#lineVersion,
          fetch: this.#fetch,
          history: options.history ?? []
        });
        const parts = [];
        for await (const event of client.chat(prompt)) {
          if (typeof event.text === "string" && event.text) parts.push(event.text);
        }
        const answer = parts.join("");
        if (!answer.trim()) throw new Error("Agent I returned an empty response");
        return options.preserveWhitespace ? answer : answer.trim();
      } catch (error) {
        lastError = error;
        const status = statusFromError(error);
        const retryable = status === 401 || status === 429 || status === null || status >= 500;
        if (!retryable || attempt === this.#maxAttempts) break;
        if (status === 401) this.#cookie = null;
        await sleep(Math.min(15000, 1000 * (2 ** (attempt - 1))));
      }
    }
    throw new Error("Agent I failed after retries: " + (lastError?.message ?? "unknown error"), { cause: lastError });
  }
}
