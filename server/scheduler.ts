import { all, run, type DB } from "./db.js";
import { localDateKey, wallClock, workdayKey } from "./metrics.js";
import { createJob, timeZoneOf, type WorkdayMode } from "./store.js";

// How long after the end time the schedule still runs, e.g. when the machine was asleep at 18:30.
const WINDOW_MIN = 3 * 60;

// Runs each developer's end-of-workday step once per weekday, at or after their end time,
// in their own time zone. Skips developers who already clocked out today; the agent itself
// skips days without activity.
export function runSchedule(db: DB, now = new Date()): number[] {
  const due = all<{ user_id: number; mode: WorkdayMode; end_time: string; last_run_date: string | null }>(
    db,
    "SELECT user_id, mode, end_time, last_run_date FROM workday WHERE mode != 'off'",
  );
  const created: number[] = [];
  for (const w of due) {
    const tz = timeZoneOf(db, w.user_id);
    const clock = wallClock(now.getTime(), tz);
    if (clock.dow === 0 || clock.dow === 6) continue;
    const today = localDateKey(now.getTime(), tz);
    const minutes = clock.hours * 60 + clock.minutes;
    const [h, m] = w.end_time.split(":").map(Number);
    const end = h * 60 + m;
    if (w.last_run_date === today || minutes < end || minutes > end + WINDOW_MIN) continue;
    const clockedOut = all<{ created_at: string }>(db, "SELECT created_at FROM clockouts WHERE user_id = ? ORDER BY id DESC LIMIT 1", w.user_id).some(
      (c) => workdayKey(Date.parse(c.created_at), tz) === workdayKey(now.getTime(), tz),
    );
    run(db, "UPDATE workday SET last_run_date = ? WHERE user_id = ?", today, w.user_id);
    if (clockedOut) continue;
    try {
      created.push(createJob(db, w.user_id, w.mode === "clockout" ? "auto-clockout" : "auto-wrapup").id);
    } catch {
      // no agent connected for this developer
    }
  }
  return created;
}

export function startScheduler(db: DB, onJob: () => void, intervalMs = 30_000) {
  const timer = setInterval(() => {
    if (runSchedule(db).length) onJob();
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
