import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./db.js";
import { countCodePoints, countUtf8Bytes, splitTextLossless } from "./chunking.js";
import { AgentGateway } from "./agent-gateway.js";
import { processJob, calculateProgress } from "./processor.js";
import { handleCompatRequest } from "./compat-http.js";

const MAX_INPUT_CHARS = 150000;
const MAX_INPUT_BYTES = 600000;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_INSTRUCTION_BYTES = 6000;
const MAX_BODY_BYTES = 2000000;
const CHUNK_CHARS = 5000;
const CHUNK_BYTES = 9000;
const DIRECT_BUDGET_BYTES = 7000;
const MAX_ACTIVE_JOBS = Math.max(1, Number(process.env.MAX_ACTIVE_JOBS ?? 20));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request body exceeds 2 MB");
    chunks.push(chunk);
  }
  if (!chunks.length) throw new HttpError(400, "Request body is required");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
    return value;
  } catch {
    throw new HttpError(400, "Request body must be a valid JSON object");
  }
}

function normalize(body) {
  const input = typeof body.input === "string" ? body.input : body.message;
  if (typeof input !== "string" || !input.trim()) throw new HttpError(400, "A non-empty input or message string is required");
  const chars = countCodePoints(input);
  const bytes = countUtf8Bytes(input);
  if (chars > MAX_INPUT_CHARS) throw new HttpError(413, "Input exceeds 150,000 Unicode characters");
  if (bytes > MAX_INPUT_BYTES) throw new HttpError(413, "Input exceeds 600,000 UTF-8 bytes");

  const instruction = body.instruction ?? (typeof body.input === "string"
    ? "Analyze the supplied source text and answer accurately."
    : "Understand and respond helpfully to the user's message.");
  if (typeof instruction !== "string" || !instruction.trim()) throw new HttpError(400, "instruction must be a non-empty string");
  if (countCodePoints(instruction) > MAX_INSTRUCTION_CHARS || countUtf8Bytes(instruction) > MAX_INSTRUCTION_BYTES) {
    throw new HttpError(413, "Instruction exceeds 2,000 characters or 6,000 UTF-8 bytes");
  }

  const requestedMode = body.mode ?? "auto";
  if (!["auto", "direct", "analyze", "transform"].includes(requestedMode)) {
    throw new HttpError(400, "mode must be auto, direct, analyze, or transform");
  }
  const combined = bytes + countUtf8Bytes(instruction);
  let mode = requestedMode;
  if (mode === "auto") mode = combined <= DIRECT_BUDGET_BYTES ? "direct" : "analyze";
  if (mode === "direct" && combined > DIRECT_BUDGET_BYTES) {
    throw new HttpError(413, "Direct mode is limited to 7,000 combined UTF-8 bytes; use analyze or transform");
  }
  return { input, instruction, mode, chars, bytes, conversationId: body.conversationId };
}

function insertJob(db, payload) {
  const now = new Date().toISOString();
  const conversationId = payload.conversationId || randomUUID();
  const jobId = randomUUID();
  const messageId = randomUUID();
  const chunks = payload.mode === "direct" ? [payload.input] :
    splitTextLossless(payload.input, { maxChars: CHUNK_CHARS, maxBytes: CHUNK_BYTES });

  if (payload.conversationId && !db.prepare("SELECT id FROM conversations WHERE id=?").get(conversationId)) {
    throw new HttpError(404, "Conversation not found");
  }

  db.transaction(() => {
    const active = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get().n;
    if (active >= MAX_ACTIVE_JOBS) throw new HttpError(429, "Job queue is full; retry later");

    if (!payload.conversationId) {
      db.prepare("INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)")
        .run(conversationId, Array.from(payload.instruction).slice(0, 72).join("") || "New conversation", now, now);
    }
    db.prepare("INSERT INTO messages(id,conversation_id,job_id,role,content,context_content,created_at) VALUES(?,?,?,'user',?,NULL,?)")
      .run(messageId, conversationId, jobId, payload.input, now);
    db.prepare("INSERT INTO jobs(id,conversation_id,user_message_id,mode,instruction,status,stage,input_chars,input_bytes,chunks_total,chunks_done,created_at,updated_at) VALUES(?,?,?,?,?,'queued','queued',?,?,?,0,?,?)")
      .run(jobId, conversationId, messageId, payload.mode, payload.instruction, payload.chars, payload.bytes, chunks.length, now, now);

    const addChunk = db.prepare("INSERT INTO job_chunks(job_id,chunk_index,content,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?)");
    chunks.forEach((text, index) => addChunk.run(jobId, index, text, now, now));
  })();

  return { jobId, conversationId, chunksTotal: chunks.length };
}

function readJob(db, id) {
  const job = db.prepare("SELECT id,conversation_id,mode,status,stage,input_chars,input_bytes,chunks_total,chunks_done,result,error,created_at,updated_at,started_at,finished_at FROM jobs WHERE id=?").get(id);
  if (!job) return null;
  return {
    jobId: job.id,
    conversationId: job.conversation_id,
    mode: job.mode,
    status: job.status,
    stage: job.stage,
    progress: calculateProgress(job),
    input: { characters: job.input_chars, utf8Bytes: job.input_bytes },
    chunks: { total: job.chunks_total, completed: job.chunks_done },
    ...(job.status === "completed" ? { result: job.result } : {}),
    ...(job.status === "failed" ? { error: job.error } : {}),
    timestamps: { createdAt: job.created_at, updatedAt: job.updated_at, startedAt: job.started_at, finishedAt: job.finished_at }
  };
}

function readConversation(db, id, includeContent) {
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
  if (!conv) return null;
  const messages = db.prepare("SELECT id,job_id,role,content,created_at FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 50")
    .all(id).reverse();
  return {
    conversationId: conv.id,
    title: conv.title,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    messages: messages.map((m) => ({
      id: m.id, jobId: m.job_id, role: m.role, createdAt: m.created_at,
      ...(includeContent ? { content: m.content } : { preview: Array.from(m.content).slice(0, 500).join("") })
    }))
  };
}

function isAuthorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function startWorker(db, gateway) {
  const poll = Math.max(100, Number(process.env.JOB_POLL_MS ?? 500));
  let stopping = false;
  let busy = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const claim = db.transaction(() => {
    const row = db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
    if (!row) return null;
    const time = new Date().toISOString();
    const changes = db.prepare("UPDATE jobs SET status='running',stage='starting',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='queued'")
      .run(time, time, row.id).changes;
    return changes === 1 ? row.id : null;
  }).immediate;

  const loop = (async () => {
    while (!stopping) {
      if (busy) { await sleep(poll); continue; }
      let id;
      try { id = claim(); } catch (error) { console.error("[queue] claim failed", error); }
      if (!id) { await sleep(poll); continue; }
      busy = true;
      try { await processJob(db, gateway, id); }
      finally { busy = false; }
    }
  })();
  return { async stop() { stopping = true; await loop; } };
}

export function createBackendServer(options = {}) {
  const db = options.db ?? openDatabase(options.databasePath);
  const gateway = options.gateway ?? new AgentGateway(options.gatewayOptions);
  const worker = startWorker(db, gateway);
  const apiToken = options.apiToken ?? process.env.API_TOKEN ?? "";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        const counts = db.prepare("SELECT SUM(status='queued') AS queued,SUM(status='running') AS running FROM jobs").get();
        return sendJson(res, 200, {
          ok: true,
          service: "agent-i-backend",
          limits: { maxInputCharacters: MAX_INPUT_CHARS, maxInputUtf8Bytes: MAX_INPUT_BYTES },
          queue: { queued: counts.queued ?? 0, running: counts.running ?? 0 }
        });
      }

      const compatHandled = await handleCompatRequest(req, res, {
        db,
        apiToken,
        readJson,
        normalize,
        insertJob,
        readJob,
        sendJson
      });
      if (compatHandled) return;

      if (!isAuthorized(req, apiToken)) return sendJson(res, 401, { error: "UNAUTHORIZED", message: "A valid Bearer token is required" });

      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        const payload = normalize(await readJson(req));
        const created = insertJob(db, payload);
        return sendJson(res, 202, {
          ...created,
          mode: payload.mode,
          status: "queued",
          input: { characters: payload.chars, utf8Bytes: payload.bytes },
          pollUrl: "/v1/jobs/" + created.jobId
        });
      }

      const jobId = url.pathname.startsWith("/v1/jobs/") ? url.pathname.slice("/v1/jobs/".length) : "";
      if (req.method === "GET" && /^[0-9a-f-]+$/i.test(jobId)) {
        const job = readJob(db, jobId);
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: "NOT_FOUND", message: "Job not found" });
      }

      const conversationId = url.pathname.startsWith("/v1/conversations/") ? url.pathname.slice("/v1/conversations/".length) : "";
      if (req.method === "GET" && /^[0-9a-f-]+$/i.test(conversationId)) {
        const conversation = readConversation(db, conversationId, url.searchParams.get("includeContent") === "1");
        return conversation ? sendJson(res, 200, conversation) : sendJson(res, 404, { error: "NOT_FOUND", message: "Conversation not found" });
      }

      return sendJson(res, 404, { error: "NOT_FOUND", message: "Route not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error("[http] request failed", error);
      return sendJson(res, status, {
        error: status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: status >= 500 ? "Internal server error" : error.message
      });
    }
  });

  return {
    server,
    db,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await worker.stop();
      if (!options.db) db.close();
    }
  };
}

async function main() {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  const token = process.env.API_TOKEN ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !token) {
    throw new Error("Set API_TOKEN before binding to a non-localhost address");
  }
  const app = createBackendServer({ apiToken: token });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, host, resolve);
  });
  console.log("[agent-i-backend] listening on http://" + host + ":" + port);
  console.log("[agent-i-backend] SQLite: " + (process.env.DATABASE_PATH ?? "./data/agent-i.sqlite"));

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log("[agent-i-backend] " + signal + ": shutting down");
    try { await app.close(); process.exit(0); }
    catch (error) { console.error("[agent-i-backend] shutdown failed", error); process.exit(1); }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[agent-i-backend] startup failed", error);
    process.exitCode = 1;
  });
}

export const backendLimits = Object.freeze({
  maxInputCharacters: MAX_INPUT_CHARS,
  maxInputUtf8Bytes: MAX_INPUT_BYTES,
  maxInstructionCharacters: MAX_INSTRUCTION_CHARS,
  chunkMaxCharacters: CHUNK_CHARS,
  chunkMaxUtf8Bytes: CHUNK_BYTES
});
