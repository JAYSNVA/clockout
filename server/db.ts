import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('developer', 'manager')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_manager ON users(role) WHERE role = 'manager';

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS git_identities (
  email TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  is_local INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TEXT,
  last_run_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS claude_events (
  id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  task TEXT,
  human INTEGER NOT NULL DEFAULT 0,
  agent INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS commits (
  sha TEXT NOT NULL,
  repo TEXT NOT NULL,
  ts TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  task TEXT,
  on_default INTEGER NOT NULL,
  PRIMARY KEY (sha, repo)
);

CREATE TABLE IF NOT EXISTS tasks_done (
  key TEXT NOT NULL,
  repo TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (key, repo)
);

CREATE TABLE IF NOT EXISTS blocked_calls (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  PRIMARY KEY (user_id, ts)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS clockouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  result_json TEXT NOT NULL,
  resumed_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Derived tables: rebuilt from events by recomputeAll(), so they can be dropped on schema changes.
const DERIVED = `
CREATE TABLE IF NOT EXISTS daily_metrics (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  active_minutes INTEGER NOT NULL,
  span_minutes INTEGER NOT NULL,
  longest_stretch_minutes INTEGER NOT NULL,
  last_break_at TEXT,
  finish_at TEXT,
  peak_parallel_sessions INTEGER NOT NULL,
  repos_touched INTEGER NOT NULL,
  context_switches INTEGER NOT NULL,
  late_night_minutes INTEGER NOT NULL,
  weekend_minutes INTEGER NOT NULL,
  commits INTEGER NOT NULL,
  agent_minutes INTEGER NOT NULL,
  agent_solo_minutes INTEGER NOT NULL,
  load_score INTEGER NOT NULL,
  blocks_json TEXT NOT NULL,
  agent_blocks_json TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS task_activity (
  task_key TEXT NOT NULL,
  repo TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  active_minutes REAL NOT NULL,
  agent_minutes INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  commits INTEGER NOT NULL,
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  PRIMARY KEY (task_key, repo, user_id, date)
);
`;

const SCHEMA_VERSION = 2;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (user_version < SCHEMA_VERSION) {
    // v1 -> v2: Claude events record who was active (you or the agent); metrics split accordingly.
    const cols = (db.prepare("PRAGMA table_info(claude_events)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("human")) db.exec("ALTER TABLE claude_events ADD COLUMN human INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("agent")) db.exec("ALTER TABLE claude_events ADD COLUMN agent INTEGER NOT NULL DEFAULT 1");
    db.exec("DROP TABLE IF EXISTS daily_metrics; DROP TABLE IF EXISTS task_activity;");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(DERIVED);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function all<T>(db: DB, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: DB, sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: DB, sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
