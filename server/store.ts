import crypto from "node:crypto";
import type { ClockoutResult, CollectPayload, JobResult, JobType, Settings } from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { all, get, run, tx, type DB } from "./db.js";
import { computeDays, type ActivityEvent } from "./metrics.js";

export interface User {
  id: number;
  name: string;
  role: "developer" | "manager";
}

export interface Device {
  id: number;
  user_id: number | null;
  name: string;
  is_local: number;
  last_seen_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
}

export interface Job {
  id: number;
  user_id: number;
  device_id: number;
  type: JobType;
  status: "pending" | "running" | "done" | "failed";
  created_at: string;
  finished_at: string | null;
  error: string | null;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
export const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const newToken = () => crypto.randomBytes(24).toString("base64url");

// ---------- settings ----------

export function getSettings(db: DB): Settings {
  const rows = all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) (s as any)[r.key] = JSON.parse(r.value);
  return s;
}

export function updateSettings(db: DB, patch: Partial<Settings>) {
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (patch[key] === undefined) continue;
    const value = typeof DEFAULT_SETTINGS[key] === "number" ? Number(patch[key]) : String(patch[key]).trim().replace(/\/+$/, "");
    if (typeof value === "number" && !Number.isFinite(value)) throw new HttpError(400, `Invalid ${key}`);
    run(db, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }
  recomputeAll(db);
}

// ---------- users and sessions ----------

export function listUsers(db: DB): User[] {
  return all<User>(db, "SELECT id, name, role FROM users ORDER BY role DESC, name");
}

export function userById(db: DB, id: number): User | undefined {
  return get<User>(db, "SELECT id, name, role FROM users WHERE id = ?", id);
}

export function signIn(db: DB, rawName: string, role: User["role"]): { user: User; token: string } {
  const name = rawName.trim();
  if (!name || name.length > 60) throw new HttpError(400, "Enter a name (1-60 characters).");
  if (role !== "developer" && role !== "manager") throw new HttpError(400, "Choose Developer or Manager.");
  let user = get<User>(db, "SELECT id, name, role FROM users WHERE name = ?", name);
  if (user && user.role !== role) {
    throw new HttpError(409, `"${user.name}" is already registered as ${user.role === "manager" ? "the manager" : "a developer"}.`);
  }
  if (!user) {
    if (role === "manager") {
      const manager = get<User>(db, "SELECT id, name, role FROM users WHERE role = 'manager'");
      if (manager) throw new HttpError(409, `There is already a manager (${manager.name}). Only one manager is allowed.`);
    }
    const res = run(db, "INSERT INTO users (name, role, created_at) VALUES (?, ?, ?)", name, role, now());
    user = { id: Number(res.lastInsertRowid), name, role };
  }
  const token = newToken();
  run(db, "INSERT INTO sessions (token, user_id) VALUES (?, ?)", hashToken(token), user.id);
  return { user, token };
}

export function userForSession(db: DB, token: string | undefined): User | undefined {
  if (!token) return undefined;
  return get<User>(db, "SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", hashToken(token));
}

export function signOut(db: DB, token: string | undefined) {
  if (token) run(db, "DELETE FROM sessions WHERE token = ?", hashToken(token));
}

export function createDeveloper(db: DB, name: string, emails: string[]): User {
  const clean = name.trim();
  if (!clean) throw new HttpError(400, "Enter a name.");
  if (get(db, "SELECT 1 FROM users WHERE name = ?", clean)) throw new HttpError(409, `"${clean}" already exists.`);
  const res = run(db, "INSERT INTO users (name, role, created_at) VALUES (?, 'developer', ?)", clean, now());
  const user: User = { id: Number(res.lastInsertRowid), name: clean, role: "developer" };
  setEmails(db, user.id, emails);
  return user;
}

export function renameUser(db: DB, id: number, name: string) {
  const clean = name.trim();
  if (!clean) throw new HttpError(400, "Enter a name.");
  const clash = get<{ id: number }>(db, "SELECT id FROM users WHERE name = ?", clean);
  if (clash && clash.id !== id) throw new HttpError(409, `"${clean}" already exists.`);
  run(db, "UPDATE users SET name = ? WHERE id = ?", clean, id);
}

export function deleteDeveloper(db: DB, id: number) {
  const user = userById(db, id);
  if (!user) throw new HttpError(404, "User not found.");
  if (user.role === "manager") throw new HttpError(400, "The manager cannot be removed.");
  run(db, "DELETE FROM users WHERE id = ?", id);
  recomputeAll(db);
}

// ---------- git identities ----------

export function emailsFor(db: DB, userId: number): string[] {
  return all<{ email: string }>(db, "SELECT email FROM git_identities WHERE user_id = ? ORDER BY email", userId).map((r) => r.email);
}

export function setEmails(db: DB, userId: number, emails: string[]) {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  for (const email of clean) {
    const owner = get<{ user_id: number; name: string }>(
      db,
      "SELECT g.user_id, u.name FROM git_identities g JOIN users u ON u.id = g.user_id WHERE g.email = ?",
      email,
    );
    if (owner && owner.user_id !== userId) throw new HttpError(409, `${email} already belongs to ${owner.name}.`);
  }
  tx(db, () => {
    run(db, "DELETE FROM git_identities WHERE user_id = ?", userId);
    for (const email of clean) run(db, "INSERT INTO git_identities (email, user_id) VALUES (?, ?)", email, userId);
  });
  recomputeAll(db);
}

function claimEmails(db: DB, userId: number, emails: string[]) {
  for (const email of emails) {
    run(db, "INSERT OR IGNORE INTO git_identities (email, user_id) VALUES (?, ?)", email.toLowerCase(), userId);
  }
}

export function unmatchedAuthors(db: DB) {
  return all<{ email: string; name: string; commits: number; last_ts: string }>(
    db,
    `SELECT c.email, MAX(c.name) AS name, COUNT(*) AS commits, MAX(c.ts) AS last_ts
       FROM commits c LEFT JOIN git_identities g ON g.email = c.email
      WHERE g.email IS NULL
      GROUP BY c.email ORDER BY commits DESC`,
  );
}

// ---------- devices ----------

export function ensureLocalDevice(db: DB, name: string): { device: Device; token: string } {
  const token = newToken();
  const existing = get<Device>(db, "SELECT * FROM devices WHERE is_local = 1");
  if (existing) {
    run(db, "UPDATE devices SET token_hash = ?, name = ? WHERE id = ?", hashToken(token), name, existing.id);
    return { device: { ...existing, name }, token };
  }
  const res = run(db, "INSERT INTO devices (name, is_local, token_hash) VALUES (?, 1, ?)", name, hashToken(token));
  return { device: get<Device>(db, "SELECT * FROM devices WHERE id = ?", Number(res.lastInsertRowid))!, token };
}

export function localDevice(db: DB): Device | undefined {
  return get<Device>(db, "SELECT * FROM devices WHERE is_local = 1");
}

export function linkLocalDevice(db: DB, userId: number) {
  const device = localDevice(db);
  if (!device) throw new HttpError(500, "Local agent is not running.");
  run(db, "UPDATE devices SET user_id = ? WHERE id = ?", userId, device.id);
}

export function registerRemoteDevice(db: DB, userName: string, deviceName: string): { user: User; token: string } {
  let user = get<User>(db, "SELECT id, name, role FROM users WHERE name = ?", userName.trim());
  if (user && user.role !== "developer") throw new HttpError(409, `"${user.name}" is the manager. Agents belong to developers.`);
  if (!user) user = createDeveloper(db, userName, []);
  const token = newToken();
  run(db, "INSERT INTO devices (user_id, name, is_local, token_hash) VALUES (?, ?, 0, ?)", user.id, deviceName, hashToken(token));
  return { user, token };
}

export function deviceForToken(db: DB, token: string | undefined): Device | undefined {
  if (!token) return undefined;
  const device = get<Device>(db, "SELECT * FROM devices WHERE token_hash = ?", hashToken(token));
  if (device) run(db, "UPDATE devices SET last_seen_at = ? WHERE id = ?", now(), device.id);
  return device;
}

export function devicesFor(db: DB, userId: number): Device[] {
  return all<Device>(db, "SELECT * FROM devices WHERE user_id = ? ORDER BY is_local DESC, id", userId);
}

// ---------- end of workday (per developer, opt-in) ----------

export type WorkdayMode = "off" | "wrapup" | "clockout";
export interface Workday {
  mode: WorkdayMode;
  endTime: string; // HH:MM, local time of the machine running Clockout
}

export function getWorkday(db: DB, userId: number): Workday {
  const row = get<{ mode: WorkdayMode; end_time: string }>(db, "SELECT mode, end_time FROM workday WHERE user_id = ?", userId);
  return row ? { mode: row.mode, endTime: row.end_time } : { mode: "off", endTime: "18:00" };
}

export function setWorkday(db: DB, userId: number, w: Partial<Workday>) {
  const current = getWorkday(db, userId);
  const mode = w.mode ?? current.mode;
  const endTime = w.endTime ?? current.endTime;
  if (!["off", "wrapup", "clockout"].includes(mode)) throw new HttpError(400, "Choose off, wrapup or clockout.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) throw new HttpError(400, "Use a time like 18:30.");
  run(
    db,
    `INSERT INTO workday (user_id, mode, end_time) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, end_time = excluded.end_time`,
    userId,
    mode,
    endTime,
  );
  return getWorkday(db, userId);
}

// ---------- jobs ----------

export function createJob(db: DB, userId: number, type: JobType): Job {
  const device = devicesFor(db, userId)[0];
  if (!device) {
    throw new HttpError(409, "No agent is connected to your account. Link this machine's agent in Settings, or run a remote agent.");
  }
  const busy = get<Job>(db, "SELECT * FROM jobs WHERE device_id = ? AND status IN ('pending', 'running') AND type = ?", device.id, type);
  if (busy) return busy;
  const res = run(
    db,
    "INSERT INTO jobs (user_id, device_id, type, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    userId,
    device.id,
    type,
    now(),
  );
  return get<Job>(db, "SELECT * FROM jobs WHERE id = ?", Number(res.lastInsertRowid))!;
}

export function jobById(db: DB, id: number) {
  return get<Job>(db, "SELECT * FROM jobs WHERE id = ?", id);
}

export function claimNextJob(db: DB, deviceId: number): Job | undefined {
  const job = get<Job>(db, "SELECT * FROM jobs WHERE device_id = ? AND status = 'pending' ORDER BY id LIMIT 1", deviceId);
  if (!job) return undefined;
  run(db, "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", now(), job.id);
  return { ...job, status: "running" };
}

export function completeJob(db: DB, jobId: number, result: JobResult | null, error?: string) {
  const job = jobById(db, jobId);
  if (!job) throw new HttpError(404, "Job not found.");
  if (!error && result?.skipped) {
    run(db, "UPDATE jobs SET status = 'done', finished_at = ?, error = ? WHERE id = ?", now(), `Skipped: ${result.skipped}`, jobId);
    if (result.payload) {
      ingestPayload(db, job.user_id, result.payload, false);
      recomputeAll(db);
    }
    return;
  }
  if (error || !result) {
    run(db, "UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", now(), error ?? "Unknown error", jobId);
    run(db, "UPDATE devices SET last_error = ? WHERE id = ?", error ?? "Unknown error", job.device_id);
    return;
  }
  tx(db, () => {
    if (result.payload) ingestPayload(db, job.user_id, result.payload, false);
    if (result.clockout) {
      run(
        db,
        "INSERT INTO clockouts (user_id, date, created_at, result_json) VALUES (?, ?, ?, ?)",
        job.user_id,
        result.clockout.date,
        now(),
        JSON.stringify(result.clockout),
      );
    }
    if (job.type === "resume") {
      run(db, "UPDATE clockouts SET resumed_at = ? WHERE user_id = ? AND resumed_at IS NULL", now(), job.user_id);
    }
    run(db, "UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?", now(), jobId);
    run(db, "UPDATE devices SET last_run_at = ?, last_error = NULL WHERE id = ?", now(), job.device_id);
  });
  if (result.payload) recomputeAll(db);
}

export function latestClockout(db: DB, userId: number): ClockoutResult | null {
  const row = get<{ result_json: string }>(db, "SELECT result_json FROM clockouts WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId);
  return row ? (JSON.parse(row.result_json) as ClockoutResult) : null;
}

// ---------- ingest and recompute ----------

export function ingestPayload(db: DB, userId: number, payload: CollectPayload, recompute = true) {
  const work = () => {
    claimEmails(db, userId, payload.localEmails);
    const ev = db.prepare(
      "INSERT OR REPLACE INTO claude_events (id, user_id, ts, session_id, repo, task, human, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of payload.claudeEvents) ev.run(e.id, userId, e.ts, e.sessionId, e.repo, e.task, e.human ? 1 : 0, e.agent ? 1 : 0);
    const bc = db.prepare("INSERT OR IGNORE INTO blocked_calls (user_id, ts) VALUES (?, ?)");
    for (const ts of payload.blockedCalls ?? []) bc.run(userId, ts);
    const cm = db.prepare("INSERT OR REPLACE INTO commits (sha, repo, ts, email, name, task, on_default) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const c of payload.commits) cm.run(c.sha, c.repo, c.ts, c.email.toLowerCase(), c.name, c.task, c.onDefault ? 1 : 0);
    const td = db.prepare("INSERT OR REPLACE INTO tasks_done (key, repo, done_at) VALUES (?, ?, ?)");
    for (const t of payload.tasks) td.run(t.key, t.repo, t.doneAt);
    const cutoff = new Date(Date.now() - 120 * 86400000).toISOString();
    run(db, "DELETE FROM claude_events WHERE ts < ?", cutoff);
    run(db, "DELETE FROM commits WHERE ts < ?", cutoff);
    run(db, "DELETE FROM blocked_calls WHERE ts < ?", cutoff);
  };
  if (recompute) {
    tx(db, work);
    recomputeAll(db);
  } else work();
}

export function recomputeAll(db: DB) {
  const { lateHour } = getSettings(db);
  const users = all<{ id: number }>(db, "SELECT id FROM users WHERE role = 'developer'");
  tx(db, () => {
    run(db, "DELETE FROM daily_metrics");
    run(db, "DELETE FROM task_activity");
    const dm = db.prepare(
      `INSERT INTO daily_metrics (user_id, date, source, active_minutes, span_minutes, longest_stretch_minutes, last_break_at, finish_at,
        peak_parallel_sessions, repos_touched, context_switches, late_night_minutes, weekend_minutes, commits, agent_minutes,
        agent_solo_minutes, load_score, blocks_json, agent_blocks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ta = db.prepare(
      `INSERT INTO task_activity (task_key, repo, user_id, date, active_minutes, agent_minutes, sessions, commits, first_ts, last_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { id } of users) {
      const events: ActivityEvent[] = [
        ...all<{ ts: string; session_id: string; repo: string; task: string | null; human: number; agent: number }>(
          db,
          "SELECT ts, session_id, repo, task, human, agent FROM claude_events WHERE user_id = ?",
          id,
        ).map((e) => ({
          ts: Date.parse(e.ts),
          kind: "claude" as const,
          sessionId: e.session_id,
          repo: e.repo,
          task: e.task,
          human: !!e.human,
          agent: !!e.agent,
        })),
        ...all<{ ts: string; repo: string; task: string | null }>(
          db,
          "SELECT c.ts, c.repo, c.task FROM commits c JOIN git_identities g ON g.email = c.email WHERE g.user_id = ?",
          id,
        ).map((c) => ({ ts: Date.parse(c.ts), kind: "git" as const, repo: c.repo, task: c.task, human: true, agent: false })),
      ];
      const { days, tasks } = computeDays(events, lateHour);
      for (const d of days) {
        dm.run(id, d.date, d.source, d.activeMinutes, d.spanMinutes, d.longestStretchMinutes, d.lastBreakAt, d.finishAt,
          d.peakParallelSessions, d.reposTouched, d.contextSwitches, d.lateNightMinutes, d.weekendMinutes, d.commits, d.agentMinutes,
          d.agentSoloMinutes, d.loadScore, JSON.stringify(d.blocks), JSON.stringify(d.agentBlocks));
      }
      for (const t of tasks) {
        ta.run(t.task, t.repo, id, t.date, t.activeMinutes, t.agentMinutes, t.sessions, t.commits,
          new Date(t.firstTs).toISOString(), new Date(t.lastTs).toISOString());
      }
    }
  });
}
