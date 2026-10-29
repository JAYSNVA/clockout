import type { pickupStatus } from "../agent/pickup.js";
import { all, get, type DB } from "./db.js";
import { DAY_ROLLOVER_HOUR, loadParts, localDateKey, wallClock, workdayKey } from "./metrics.js";
import { devicesFor, emailsFor, getSettings, timeZoneOf, type Job } from "./store.js";

const DAY = 86400000;

interface MetricRow {
  user_id: number;
  date: string;
  source: string;
  active_minutes: number;
  span_minutes: number;
  longest_stretch_minutes: number;
  last_break_at: string | null;
  finish_at: string | null;
  peak_parallel_sessions: number;
  repos_touched: number;
  context_switches: number;
  late_night_minutes: number;
  weekend_minutes: number;
  commits: number;
  agent_minutes: number;
  agent_solo_minutes: number;
  load_score: number;
  blocks_json: string;
  agent_blocks_json: string;
}

export type TaskStatus = "Done" | "In progress" | "Stalled";

export interface TaskSummary {
  key: string;
  repos: string[];
  status: TaskStatus;
  minutes: number;
  agentMinutes: number;
  commits: number;
  sessions: number;
  firstSeen: string;
  lastSeen: string;
  doneAt: string | null;
  cycleDays: number | null;
  contributors: { userId: number; minutes: number; agentMinutes: number }[];
}

function dayKeys(days: number, end = new Date(), tz?: string): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(localDateKey(end.getTime() - i * DAY, tz));
  return keys;
}

// Monday of the week containing `ms` (in `tz`), as a date key.
export function weekKey(ms: number, tz?: string) {
  const d = new Date(`${localDateKey(ms, tz)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function weekKeys(weeks: number): string[] {
  const keys: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) keys.push(weekKey(Date.now() - i * 7 * DAY));
  return keys;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

// All Jira tasks with status, time and contributors. `Unassigned` is excluded.
export function taskSummaries(db: DB, userIds?: number[]): TaskSummary[] {
  const rows = all<{ task_key: string; repo: string; user_id: number; minutes: number; agent_minutes: number; commits: number; sessions: number; first_ts: string; last_ts: string }>(
    db,
    `SELECT task_key, repo, user_id, SUM(active_minutes) AS minutes, SUM(agent_minutes) AS agent_minutes, SUM(commits) AS commits, SUM(sessions) AS sessions,
            MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts
       FROM task_activity WHERE task_key != 'Unassigned'
      GROUP BY task_key, repo, user_id`,
  );
  const done = new Map<string, string>();
  for (const r of all<{ key: string; done_at: string }>(db, "SELECT key, MIN(done_at) AS done_at FROM tasks_done WHERE done_at IS NOT NULL GROUP BY key")) {
    done.set(r.key, r.done_at);
  }
  const tasks = new Map<string, TaskSummary>();
  for (const r of rows) {
    let t = tasks.get(r.task_key);
    if (!t) {
      t = { key: r.task_key, repos: [], status: "Stalled", minutes: 0, agentMinutes: 0, commits: 0, sessions: 0, firstSeen: r.first_ts, lastSeen: r.last_ts, doneAt: null, cycleDays: null, contributors: [] };
      tasks.set(r.task_key, t);
    }
    if (!t.repos.includes(r.repo)) t.repos.push(r.repo);
    t.minutes += r.minutes;
    t.agentMinutes += r.agent_minutes;
    t.commits += r.commits;
    t.sessions += r.sessions;
    if (r.first_ts < t.firstSeen) t.firstSeen = r.first_ts;
    if (r.last_ts > t.lastSeen) t.lastSeen = r.last_ts;
    const c = t.contributors.find((x) => x.userId === r.user_id);
    if (c) {
      c.minutes += r.minutes;
      c.agentMinutes += r.agent_minutes;
    } else t.contributors.push({ userId: r.user_id, minutes: r.minutes, agentMinutes: r.agent_minutes });
  }
  const now = Date.now();
  for (const t of tasks.values()) {
    t.doneAt = done.get(t.key) ?? null;
    t.minutes = round1(t.minutes);
    if (t.doneAt) {
      t.status = "Done";
      t.cycleDays = round1(Math.max(0, (Date.parse(t.doneAt) - Date.parse(t.firstSeen)) / DAY));
    } else {
      t.status = now - Date.parse(t.lastSeen) <= 3 * DAY ? "In progress" : "Stalled";
    }
  }
  let list = [...tasks.values()];
  if (userIds) list = list.filter((t) => t.contributors.some((c) => userIds.includes(c.userId)));
  return list.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function metricsFor(db: DB, userIds: number[], since: string): MetricRow[] {
  if (userIds.length === 0) return [];
  return all<MetricRow>(
    db,
    `SELECT * FROM daily_metrics WHERE date >= ? AND user_id IN (${userIds.map(() => "?").join(",")}) ORDER BY date`,
    since,
    ...userIds,
  );
}

function shapeDay(m: MetricRow | undefined, date: string) {
  return {
    date,
    source: m?.source ?? null,
    activeMinutes: m?.active_minutes ?? 0,
    spanMinutes: m?.span_minutes ?? 0,
    longestStretchMinutes: m?.longest_stretch_minutes ?? 0,
    lastBreakAt: m?.last_break_at ?? null,
    finishAt: m?.finish_at ?? null,
    peakParallelSessions: m?.peak_parallel_sessions ?? 0,
    reposTouched: m?.repos_touched ?? 0,
    contextSwitches: m?.context_switches ?? 0,
    lateNightMinutes: m?.late_night_minutes ?? 0,
    weekendMinutes: m?.weekend_minutes ?? 0,
    commits: m?.commits ?? 0,
    agentMinutes: m?.agent_minutes ?? 0,
    agentSoloMinutes: m?.agent_solo_minutes ?? 0,
    loadScore: m?.load_score ?? 0,
    loadParts: loadParts({
      activeMinutes: m?.active_minutes ?? 0,
      longestStretchMinutes: m?.longest_stretch_minutes ?? 0,
      peakParallelSessions: m?.peak_parallel_sessions ?? 0,
      lateNightMinutes: m?.late_night_minutes ?? 0,
      contextSwitches: m?.context_switches ?? 0,
    }),
    blocks: m ? (JSON.parse(m.blocks_json) as { start: number; end: number }[]) : [],
    agentBlocks: m ? (JSON.parse(m.agent_blocks_json) as { start: number; end: number }[]) : [],
  };
}

export function developerOverview(db: DB, userId: number) {
  const keys = dayKeys(14, new Date(), timeZoneOf(db, userId));
  const rows = metricsFor(db, [userId], keys[0]);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const days = keys.map((k) => shapeDay(byDate.get(k), k));
  const devices = devicesFor(db, userId);
  const latestJob = get<Job>(db, "SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId) ?? null;
  const lastClockout = get<{ result_json: string; created_at: string; resumed_at: string | null }>(
    db,
    "SELECT result_json, created_at, resumed_at FROM clockouts WHERE user_id = ? ORDER BY id DESC LIMIT 1",
    userId,
  );
  const clockout = lastClockout ? { ...JSON.parse(lastClockout.result_json), createdAt: lastClockout.created_at, resumedAt: lastClockout.resumed_at } : null;
  const paused = !!clockout && !clockout.resumedAt && Date.parse(clockout.pauseUntil) > Date.now();
  const tasks = taskSummaries(db, [userId]).map((t) => {
    const mine = t.contributors.find((c) => c.userId === userId);
    return { ...t, myMinutes: round1(mine?.minutes ?? 0), myAgentMinutes: mine?.agentMinutes ?? 0 };
  });
  return {
    today: days[days.length - 1],
    days,
    tasks,
    emails: emailsFor(db, userId),
    agent: devices.map((d) => ({ id: d.id, name: d.name, isLocal: !!d.is_local, lastSeenAt: d.last_seen_at, lastRunAt: d.last_run_at, lastError: d.last_error })),
    latestJob,
    clockout,
    paused,
    timeBack: timeGivenBack(db, userId),
    pickup: null as ReturnType<typeof pickupStatus>,
    hasData: rows.length > 0,
  };
}

// Minutes after midnight, with times before the day rollover (05:00) counted as the previous evening.
export function eveningMinutes(iso: string, tz?: string) {
  const w = wallClock(Date.parse(iso), tz);
  const m = w.hours * 60 + w.minutes;
  return m < DAY_ROLLOVER_HOUR * 60 ? m + 1440 : m;
}

// Average finish over the 14 workdays before `date` (needs at least 3 days with activity).
function usualFinish(db: DB, userId: number, date: string): number | null {
  const from = localDateKey(Date.parse(`${date}T12:00:00`) - 14 * DAY);
  const rows = all<{ finish_at: string }>(
    db,
    "SELECT finish_at FROM daily_metrics WHERE user_id = ? AND date >= ? AND date < ? AND finish_at IS NOT NULL",
    userId,
    from,
    date,
  );
  if (rows.length < 3) return null;
  const tz = timeZoneOf(db, userId);
  return Math.round(rows.reduce((a, r) => a + eveningMinutes(r.finish_at, tz), 0) / rows.length);
}

// What clocking out gave back: earlier evenings than usual, agent calls stopped at night, and
// late-night work compared with last week. If you resumed and kept working after clocking out,
// your real finish counts, not the button press.
export function timeGivenBack(db: DB, userId: number) {
  const tz = timeZoneOf(db, userId);
  const week = weekKey(Date.now(), tz);
  const today = localDateKey(Date.now(), tz);
  const clockouts = all<{ date: string; created_at: string }>(
    db,
    "SELECT date, created_at FROM clockouts WHERE user_id = ? AND created_at >= ? ORDER BY id",
    userId,
    new Date(Date.now() - 15 * DAY).toISOString(),
  );
  // One entry per workday: the last clock-out of that day.
  const byDay = new Map<string, string>();
  for (const c of clockouts) byDay.set(workdayKey(Date.parse(c.created_at), tz), c.created_at);
  const evenings = [...byDay].map(([day, at]) => {
    const finish = get<{ finish_at: string | null }>(db, "SELECT finish_at FROM daily_metrics WHERE user_id = ? AND date = ?", userId, day)?.finish_at;
    const finishedAt = finish && finish > at ? finish : at;
    const usual = usualFinish(db, userId, day);
    const back = usual == null ? null : Math.max(0, usual - eveningMinutes(finishedAt, tz));
    return { day, clockedOutAt: at, finishedAt, workedAfter: finishedAt !== at, usualFinishMinutes: usual, backMinutes: back };
  });
  const thisWeek = evenings.filter((e) => weekKey(Date.parse(`${e.day}T12:00:00`)) === week);

  const weekStart = new Date(`${week}T00:00:00`).toISOString();
  const blocked = get<{ n: number; last: string | null }>(
    db,
    "SELECT COUNT(*) AS n, MAX(ts) AS last FROM blocked_calls WHERE user_id = ? AND ts >= ?",
    userId,
    weekStart,
  )!;

  // Late night this week so far vs the same days last week.
  const daysIntoWeek = Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${week}T12:00:00`)) / DAY);
  const lastWeekStart = localDateKey(Date.parse(`${week}T12:00:00`) - 7 * DAY);
  const lastWeekEnd = localDateKey(Date.parse(`${lastWeekStart}T12:00:00`) + daysIntoWeek * DAY);
  const late = (from: string, to: string) =>
    get<{ m: number | null }>(db, "SELECT SUM(late_night_minutes) AS m FROM daily_metrics WHERE user_id = ? AND date >= ? AND date <= ?", userId, from, to)!.m ?? 0;

  return {
    usualFinishMinutes: usualFinish(db, userId, today),
    last: evenings[evenings.length - 1] ?? null,
    week: {
      evenings: thisWeek.length,
      backMinutes: thisWeek.reduce((a, e) => a + (e.backMinutes ?? 0), 0),
      blockedCalls: blocked.n,
      lastBlockedAt: blocked.last,
    },
    lateNight: { thisWeek: late(week, today), lastWeek: late(lastWeekStart, lastWeekEnd) },
  };
}

const TOP_TASKS = 8;

export function managerOverview(db: DB, rangeDays: number, filterUserId?: number) {
  const settings = getSettings(db);
  const allDevs = all<{ id: number; name: string }>(db, "SELECT id, name FROM users WHERE role = 'developer' ORDER BY name");
  const devs = filterUserId ? allDevs.filter((d) => d.id === filterUserId) : allDevs;
  const ids = devs.map((d) => d.id);
  const nameOf = new Map(allDevs.map((d) => [d.id, d.name]));
  const keys = dayKeys(rangeDays);
  const since = keys[0];
  const metrics = metricsFor(db, ids, dayKeys(42)[0]);
  const inRange = metrics.filter((m) => m.date >= since);
  const tasks = taskSummaries(db, ids);
  const doneInRange = tasks.filter((t) => t.doneAt && localDateKey(Date.parse(t.doneAt)) >= since);
  const weekAgo = localDateKey(Date.now() - 6 * DAY);

  // Task activity in range, for time splits.
  const activity = ids.length
    ? all<{ task_key: string; user_id: number; minutes: number }>(
        db,
        `SELECT task_key, user_id, SUM(active_minutes) AS minutes FROM task_activity
          WHERE date >= ? AND user_id IN (${ids.map(() => "?").join(",")}) GROUP BY task_key, user_id`,
        since,
        ...ids,
      )
    : [];
  const statusOf = new Map(tasks.map((t) => [t.key, t.status]));

  // KPI tiles
  const recentLoad = new Map<number, number[]>();
  for (const m of metrics.filter((m) => m.date >= weekAgo)) {
    if (!recentLoad.has(m.user_id)) recentLoad.set(m.user_id, []);
    recentLoad.get(m.user_id)!.push(m.load_score);
  }
  const avgLoad7 = (id: number) => {
    const v = recentLoad.get(id) ?? [];
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / 7) : 0;
  };
  const kpis = {
    tasksDoneThisWeek: tasks.filter((t) => t.doneAt && localDateKey(Date.parse(t.doneAt)) >= weekAgo).length,
    medianCycleDays: median(doneInRange.map((t) => t.cycleDays!).filter((x) => x != null)),
    activeHours: round1(inRange.reduce((a, m) => a + m.active_minutes, 0) / 60),
    agentHours: round1(inRange.reduce((a, m) => a + m.agent_minutes, 0) / 60),
    overloaded: ids.filter((id) => avgLoad7(id) >= settings.loadThreshold).length,
    developers: ids.length,
    loadThreshold: settings.loadThreshold,
  };

  // Developer table
  const developers = devs.map((d) => {
    const ms = inRange.filter((m) => m.user_id === d.id);
    const mine = tasks.filter((t) => t.contributors.some((c) => c.userId === d.id));
    return {
      id: d.id,
      name: d.name,
      avgLoad: ms.length ? Math.round(ms.reduce((a, m) => a + m.load_score, 0) / rangeDays) : 0,
      load7: avgLoad7(d.id),
      activeHours: round1(ms.reduce((a, m) => a + m.active_minutes, 0) / 60),
      agentHours: round1(ms.reduce((a, m) => a + m.agent_minutes, 0) / 60),
      longestStretchMinutes: Math.max(0, ...ms.map((m) => m.longest_stretch_minutes)),
      lateNightDays: ms.filter((m) => m.late_night_minutes > 0).length,
      tasksInProgress: mine.filter((t) => t.status === "In progress").length,
      tasksDone: mine.filter((t) => t.doneAt && localDateKey(Date.parse(t.doneAt)) >= since).length,
      gitOnly: ms.length > 0 && ms.every((m) => m.source === "git-only"),
      hasData: ms.length > 0,
    };
  });

  // Pie: time per task (top N + Other) and per developer
  const minutesByTask = new Map<string, number>();
  for (const a of activity) minutesByTask.set(a.task_key, (minutesByTask.get(a.task_key) ?? 0) + a.minutes);
  const sortedTasks = [...minutesByTask].sort((a, b) => b[1] - a[1]);
  const topTasks = sortedTasks.slice(0, TOP_TASKS).map(([k]) => k);
  const bucket = (k: string) => (topTasks.includes(k) ? k : "Other tasks");
  const pieByTask = [
    ...sortedTasks.slice(0, TOP_TASKS).map(([name, m]) => ({ name, hours: round1(m / 60) })),
    ...(sortedTasks.length > TOP_TASKS ? [{ name: "Other tasks", hours: round1(sortedTasks.slice(TOP_TASKS).reduce((a, [, m]) => a + m, 0) / 60) }] : []),
  ].filter((x) => x.hours > 0);
  const pieByDeveloper = developers.filter((d) => d.activeHours > 0).map((d) => ({ name: d.name, hours: d.activeHours }));

  // Sankey: developer -> task -> status, width = hours
  const nodes: { name: string; kind: "developer" | "task" | "status" }[] = [];
  const nodeIndex = new Map<string, number>();
  const node = (name: string, kind: "developer" | "task" | "status") => {
    const id = `${kind}:${name}`;
    if (!nodeIndex.has(id)) {
      nodeIndex.set(id, nodes.length);
      nodes.push({ name, kind });
    }
    return nodeIndex.get(id)!;
  };
  const linkMap = new Map<string, { source: number; target: number; value: number }>();
  const addLink = (source: number, target: number, value: number) => {
    const k = `${source}-${target}`;
    const l = linkMap.get(k);
    if (l) l.value += value;
    else linkMap.set(k, { source, target, value });
  };
  for (const a of activity) {
    if (a.minutes <= 0) continue;
    const taskName = bucket(a.task_key);
    const status = a.task_key === "Unassigned" ? "No Jira key" : statusOf.get(a.task_key) ?? "In progress";
    const dev = node(nameOf.get(a.user_id) ?? `#${a.user_id}`, "developer");
    const task = node(taskName, "task");
    const st = node(status, "status");
    addLink(dev, task, a.minutes / 60);
    addLink(task, st, a.minutes / 60);
  }
  const sankey = {
    nodes,
    links: [...linkMap.values()].map((l) => ({ ...l, value: round1(l.value) })).filter((l) => l.value > 0),
  };

  // Weekly: tasks done per developer (last 6 weeks), cycle time trend, load vs output
  const weeks = weekKeys(6);
  const weeklyDone = weeks.map((w) => {
    const row: Record<string, string | number> = { week: w };
    for (const d of devs) {
      row[d.name] = tasks.filter(
        (t) => t.doneAt && weekKey(Date.parse(t.doneAt)) === w && t.contributors.some((c) => c.userId === d.id),
      ).length;
    }
    return row;
  });
  const cycleTrend = weeks.map((w) => ({
    week: w,
    medianCycleDays: median(tasks.filter((t) => t.doneAt && weekKey(Date.parse(t.doneAt)) === w).map((t) => t.cycleDays!)),
  }));
  const scatter = devs.flatMap((d) =>
    weeks.map((w) => {
      const hours = metrics.filter((m) => m.user_id === d.id && weekKey(Date.parse(`${m.date}T12:00:00`)) === w).reduce((a, m) => a + m.active_minutes, 0) / 60;
      const done = tasks.filter((t) => t.doneAt && weekKey(Date.parse(t.doneAt)) === w && t.contributors.some((c) => c.userId === d.id)).length;
      return { developer: d.name, week: w, hours: round1(hours), tasksDone: done };
    }).filter((p) => p.hours > 0 || p.tasksDone > 0),
  );

  // Load trend per developer per day
  const loadTrend = keys.map((k) => {
    const row: Record<string, string | number> = { date: k };
    for (const d of devs) row[d.name] = inRange.find((m) => m.user_id === d.id && m.date === k)?.load_score ?? 0;
    return row;
  });

  return {
    rangeDays,
    settings,
    developers,
    allDevelopers: allDevs,
    kpis,
    pieByTask,
    pieByDeveloper,
    sankey,
    weeklyDone,
    cycleTrend,
    scatter,
    loadTrend,
    hasData: metrics.length > 0,
  };
}

export function developerDetail(db: DB, userId: number) {
  const tasks = taskSummaries(db, [userId]).map((t) => ({
    key: t.key,
    repos: t.repos,
    status: t.status,
    hours: round1((t.contributors.find((c) => c.userId === userId)?.minutes ?? 0) / 60),
    agentHours: round1((t.contributors.find((c) => c.userId === userId)?.agentMinutes ?? 0) / 60),
    commits: t.commits,
    cycleDays: t.cycleDays,
    lastSeen: t.lastSeen,
  }));
  const weeks = weekKeys(6);
  const metrics = metricsFor(db, [userId], weeks[0]);
  const allTasks = taskSummaries(db, [userId]);
  const weekly = weeks.map((w) => {
    const ms = metrics.filter((m) => weekKey(Date.parse(`${m.date}T12:00:00`)) === w);
    return {
      week: w,
      tasksDone: allTasks.filter((t) => t.doneAt && weekKey(Date.parse(t.doneAt)) === w).length,
      activeHours: round1(ms.reduce((a, m) => a + m.active_minutes, 0) / 60),
      agentHours: round1(ms.reduce((a, m) => a + m.agent_minutes, 0) / 60),
      avgLoad: Math.round(ms.reduce((a, m) => a + m.load_score, 0) / 7),
      lateNightMinutes: ms.reduce((a, m) => a + m.late_night_minutes, 0),
    };
  });
  return { tasks, weekly };
}
