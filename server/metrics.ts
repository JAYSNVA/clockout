// Turns raw activity events into daily workload metrics and per-task time.
// Pure functions: no database, no clock.
//
// "You" metrics (active time, breaks, longest stretch, context switches, late night) come only
// from the developer's own activity: prompts and commands typed into Claude Code, and commits.
// Claude working on its own is measured separately as agent time, so a long agent run never
// hides a break or stretches a working day.

export interface ActivityEvent {
  ts: number; // epoch ms
  kind: "claude" | "git";
  sessionId?: string;
  repo: string;
  task: string | null;
  human: boolean;
  agent: boolean;
}

export interface Block {
  start: number; // minutes since local midnight
  end: number;
}

export interface DayMetrics {
  date: string;
  source: "claude+git" | "git-only";
  activeMinutes: number;
  spanMinutes: number;
  longestStretchMinutes: number;
  lastBreakAt: string | null;
  finishAt: string | null;
  peakParallelSessions: number;
  reposTouched: number;
  contextSwitches: number;
  lateNightMinutes: number;
  weekendMinutes: number;
  commits: number;
  agentMinutes: number;
  agentSoloMinutes: number;
  loadScore: number;
  blocks: Block[];
  agentBlocks: Block[];
}

export interface TaskDay {
  task: string;
  repo: string;
  date: string;
  activeMinutes: number;
  agentMinutes: number;
  sessions: number;
  commits: number;
  firstTs: number;
  lastTs: number;
}

export const BREAK_GAP_MIN = 15;
export const MIN_BLOCK_MIN = 5;
const EARLY_HOUR = 6;
// A working day runs until 05:00, so 01:30 still counts as the previous evening's finish.
export const DAY_ROLLOVER_HOUR = 5;
const MIN = 60000;

// ---------- wall-clock time in a developer's time zone ----------
// Without a time zone, the server's own zone is used.

export const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatters = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number>();

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Offset of `tz` from UTC at instant `ms`, cached per hour.
function offsetMs(ms: number, tz: string) {
  const key = `${tz}|${Math.floor(ms / 3600000)}`;
  const cached = offsets.get(key);
  if (cached !== undefined) return cached;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  offsets.set(key, offset);
  return offset;
}

// Year, month, day, weekday, hour, minute of `ms` as seen in `tz`.
export function wallClock(ms: number, tz = SERVER_TZ) {
  const d = new Date(ms + offsetMs(ms, tz));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dow: d.getUTCDay(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
  };
}

export function localDateKey(ms: number, tz?: string) {
  const w = wallClock(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

export function workdayKey(ms: number, tz?: string) {
  return localDateKey(ms - DAY_ROLLOVER_HOUR * 3600000, tz);
}

function minutesOfDay(ms: number, tz?: string) {
  const w = wallClock(ms, tz);
  return w.hours * 60 + w.minutes + w.seconds / 60;
}

interface LoadInputs {
  activeMinutes: number;
  longestStretchMinutes: number;
  peakParallelSessions: number;
  lateNightMinutes: number;
  contextSwitches: number;
}

// The five parts of the load score, in points. Documented in the README.
export function loadParts(m: LoadInputs) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    handsOn: r(35 * clamp(m.activeMinutes / 600)),
    stretch: r(20 * clamp(m.longestStretchMinutes / 240)),
    parallel: r(15 * clamp((m.peakParallelSessions - 1) / 3)),
    lateNight: r(15 * clamp(m.lateNightMinutes / 120)),
    switches: r(15 * clamp(m.contextSwitches / 20)),
  };
}

// Load score 0-100.
export function loadScore(m: LoadInputs) {
  const p = loadParts(m);
  return Math.round(p.handsOn + p.stretch + p.parallel + p.lateNight + p.switches);
}

interface RawBlock {
  events: ActivityEvent[];
  start: number;
  end: number; // ms, includes the minimum block length
}

// Groups sorted events into blocks; a gap longer than the break threshold starts a new block.
function splitBlocks(events: ActivityEvent[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (const e of events) {
    const last = blocks[blocks.length - 1];
    if (last && e.ts - last.events[last.events.length - 1].ts <= BREAK_GAP_MIN * MIN) {
      last.events.push(e);
    } else {
      blocks.push({ events: [e], start: e.ts, end: e.ts });
    }
  }
  for (const b of blocks) {
    const lastTs = b.events[b.events.length - 1].ts;
    b.end = Math.max(lastTs, b.start + MIN_BLOCK_MIN * MIN);
  }
  return blocks;
}

// Agent minutes as intervals: consecutive minutes (gaps under the break threshold) join up.
function agentIntervals(minutes: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const t of minutes) {
    const last = out[out.length - 1];
    if (last && t - last[1] <= BREAK_GAP_MIN * MIN) last[1] = t + MIN;
    else out.push([t, t + MIN]);
  }
  return out;
}

function peakParallel(events: ActivityEvent[]): number {
  const bySession = new Map<string, number[]>();
  for (const e of events) {
    if (e.kind !== "claude" || !e.sessionId) continue;
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId)!.push(e.ts);
  }
  const points: [number, number][] = [];
  for (const times of bySession.values()) {
    times.sort((a, b) => a - b);
    let start = times[0];
    let prev = times[0];
    for (const t of times.slice(1).concat([Infinity])) {
      if (t - prev > BREAK_GAP_MIN * MIN) {
        points.push([start, 1], [prev + MIN, -1]);
        start = t;
      }
      prev = t;
    }
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, delta] of points) {
    cur += delta;
    peak = Math.max(peak, cur);
  }
  return peak;
}

const toBlock = (start: number, end: number, tz?: string): Block => ({
  start: Math.round(minutesOfDay(start, tz)),
  end: Math.round(minutesOfDay(start, tz) + (end - start) / MIN),
});

// `timeZone` is the developer's own zone: days, late night and finish times follow their clock.
export function computeDays(events: ActivityEvent[], lateHour: number, timeZone?: string): { days: DayMetrics[]; tasks: TaskDay[] } {
  const tz = isTimeZone(timeZone) ? timeZone : undefined;
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const byDate = new Map<string, ActivityEvent[]>();
  const finish = new Map<string, number>(); // workday -> last moment of your own activity
  for (const e of sorted) {
    const key = localDateKey(e.ts, tz);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(e);
    if (e.human) finish.set(workdayKey(e.ts, tz), e.ts);
  }

  const days: DayMetrics[] = [];
  const tasks: TaskDay[] = [];

  for (const [date, evs] of byDate) {
    const mine = evs.filter((e) => e.human);
    const blocks = splitBlocks(mine);
    const blockMinutes = blocks.map((b) => (b.end - b.start) / MIN);
    const activeMinutes = blockMinutes.reduce((a, b) => a + b, 0);

    let lateNight = 0;
    for (const b of blocks) {
      for (let t = b.start; t < b.end; t += MIN) {
        const h = wallClock(t, tz).hours;
        if (h >= lateHour || h < EARLY_HOUR) lateNight++;
      }
    }

    // Moving to another repo, Jira task or Claude Code session between one action and the next.
    let switches = 0;
    for (let i = 1; i < mine.length; i++) {
      const [a, b] = [mine[i - 1], mine[i]];
      const otherSession = a.kind === "claude" && b.kind === "claude" && a.sessionId !== b.sessionId;
      if (a.repo !== b.repo || a.task !== b.task || otherSession) switches++;
    }

    const agentMinuteSet = [...new Set(evs.filter((e) => e.agent).map((e) => e.ts))].sort((a, b) => a - b);
    const inYourBlocks = (t: number) => blocks.some((b) => t >= b.start && t <= b.end);
    const agentSolo = agentMinuteSet.filter((t) => !inYourBlocks(t)).length;

    const dow = wallClock(evs[0].ts, tz).dow;
    const metrics = {
      activeMinutes: Math.round(activeMinutes),
      longestStretchMinutes: Math.round(blockMinutes.length ? Math.max(...blockMinutes) : 0),
      peakParallelSessions: peakParallel(evs),
      lateNightMinutes: lateNight,
      contextSwitches: switches,
    };
    const yourFinish = finish.get(date);
    days.push({
      date,
      source: evs.some((e) => e.kind === "claude") ? "claude+git" : "git-only",
      ...metrics,
      spanMinutes: blocks.length ? Math.round((blocks[blocks.length - 1].end - blocks[0].start) / MIN) : 0,
      lastBreakAt: blocks.length > 1 ? new Date(blocks[blocks.length - 1].start).toISOString() : null,
      finishAt: yourFinish ? new Date(yourFinish).toISOString() : null,
      reposTouched: new Set(evs.map((e) => e.repo)).size,
      weekendMinutes: dow === 0 || dow === 6 ? Math.round(activeMinutes) : 0,
      commits: evs.filter((e) => e.kind === "git").length,
      agentMinutes: agentMinuteSet.length,
      agentSoloMinutes: agentSolo,
      loadScore: loadScore(metrics),
      blocks: blocks.map((b) => toBlock(b.start, b.end, tz)),
      agentBlocks: agentIntervals(agentMinuteSet).map(([s, e]) => toBlock(s, e, tz)),
    });

    // Per task: your time goes to the task of your earlier action for each gap inside a block
    // (the block's minimum length goes to its first action); agent minutes are counted per task.
    const perTask = new Map<string, TaskDay & { sessionSet: Set<string>; agentSet: Set<number> }>();
    const taskOf = (e: ActivityEvent) => {
      const task = e.task ?? "Unassigned";
      const key = `${task}\u0000${e.repo}`;
      let t = perTask.get(key);
      if (!t) {
        t = { task, repo: e.repo, date, activeMinutes: 0, agentMinutes: 0, sessions: 0, commits: 0, firstTs: e.ts, lastTs: e.ts, sessionSet: new Set(), agentSet: new Set() };
        perTask.set(key, t);
      }
      t.firstTs = Math.min(t.firstTs, e.ts);
      t.lastTs = Math.max(t.lastTs, e.ts);
      return t;
    };
    for (const e of evs) {
      const t = taskOf(e);
      if (e.kind === "git") t.commits++;
      if (e.sessionId) t.sessionSet.add(e.sessionId);
      if (e.agent) t.agentSet.add(e.ts);
    }
    for (const b of blocks) {
      const total = (b.end - b.start) / MIN;
      let assigned = 0;
      b.events.forEach((e, i) => {
        const next = b.events[i + 1];
        const minutes = next ? (next.ts - e.ts) / MIN : 0;
        assigned += minutes;
        taskOf(e).activeMinutes += minutes;
      });
      if (total > assigned) taskOf(b.events[0]).activeMinutes += total - assigned;
    }
    for (const { sessionSet, agentSet, ...t } of perTask.values()) {
      tasks.push({ ...t, sessions: sessionSet.size, agentMinutes: agentSet.size, activeMinutes: Math.round(t.activeMinutes * 10) / 10 });
    }
  }

  return { days, tasks };
}
