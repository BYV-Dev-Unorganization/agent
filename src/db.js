import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New conversation', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, job_id TEXT, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, context_content TEXT, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)",
  "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, mode TEXT NOT NULL CHECK(mode IN ('direct','analyze','transform')), instruction TEXT NOT NULL, prompt_format TEXT NOT NULL DEFAULT 'standard' CHECK(prompt_format IN ('standard','raw')), status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')), stage TEXT NOT NULL DEFAULT 'queued', input_chars INTEGER NOT NULL, input_bytes INTEGER NOT NULL, chunks_total INTEGER NOT NULL DEFAULT 0, chunks_done INTEGER NOT NULL DEFAULT 0, result TEXT, context_summary TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, created_at)",
  "CREATE TABLE IF NOT EXISTS job_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, summary TEXT, output TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')), attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(job_id, chunk_index))",
  "CREATE INDEX IF NOT EXISTS idx_chunks_queue ON job_chunks(job_id, status, chunk_index)"
].join(";");

export function openDatabase(filename = process.env.DATABASE_PATH ?? "./data/agent-i.sqlite") {
  const resolved = filename === ":memory:" ? filename : path.resolve(filename);
  if (resolved !== ":memory:") fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);

  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all();
  if (!jobColumns.some((column) => column.name === "prompt_format")) {
    db.exec("ALTER TABLE jobs ADD COLUMN prompt_format TEXT NOT NULL DEFAULT 'standard'");
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE job_chunks SET status='pending', updated_at=?, error=NULL WHERE status='running'").run(now);
  db.prepare("UPDATE jobs SET status='queued', stage='recovered_after_restart', updated_at=?, error=NULL WHERE status='running'").run(now);
  return db;
}
