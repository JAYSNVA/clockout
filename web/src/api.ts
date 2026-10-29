export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface Settings {
  jiraBaseUrl: string;
  lateHour: number;
  resumeHour: number;
  loadThreshold: number;
}

export interface Me {
  user: { id: number; name: string; role: "developer" | "manager" };
  emails: string[];
  localAgent: { linkedTo: string | null; isMine: boolean } | null;
  canLinkLocal: boolean;
  settings: Settings;
  demo: boolean;
  workday: Workday | null;
}

export interface Workday {
  mode: "off" | "wrapup" | "clockout";
  endTime: string;
}

export interface Day {
  date: string;
  source: "claude+git" | "git-only" | null;
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
  loadParts: { handsOn: number; stretch: number; parallel: number; lateNight: number; switches: number };
  blocks: { start: number; end: number }[];
  agentBlocks: { start: number; end: number }[];
}

export type TaskStatus = "Done" | "In progress" | "Stalled";

export interface Job {
  id: number;
  type: "collect" | "clockout" | "resume" | "auto-clockout" | "auto-wrapup";
  status: "pending" | "running" | "done" | "failed";
  created_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface SavedRepo {
  repo: string;
  status: "saved" | "skipped";
  branch?: string;
  files?: number;
  reason?: string;
}

export interface Clockout {
  date: string;
  savedRepos: SavedRepo[];
  pauseUntil: string | null;
  auto?: boolean;
  tomorrowPath: string;
  tomorrowMd: string;
  usedClaudeSummary: boolean;
  summarySource?: "api" | "claude-code" | null;
  pickupRepos?: string[];
  prunedBranches?: number;
  createdAt: string;
  resumedAt: string | null;
}

export interface DeveloperOverview {
  today: Day;
  days: Day[];
  tasks: { key: string; repos: string[]; status: TaskStatus; myMinutes: number; myAgentMinutes: number; commits: number; cycleDays: number | null; lastSeen: string }[];
  emails: string[];
  agent: { id: number; name: string; isLocal: boolean; lastSeenAt: string | null; lastRunAt: string | null; lastError: string | null }[];
  latestJob: Job | null;
  clockout: Clockout | null;
  paused: boolean;
  timeBack: TimeBack;
  pickup: { date: string; repos: { repo: string; pickedUpAt: string | null }[] } | null;
  hasData: boolean;
}

export interface TimeBack {
  usualFinishMinutes: number | null;
  last: {
    day: string;
    clockedOutAt: string;
    finishedAt: string;
    workedAfter: boolean;
    usualFinishMinutes: number | null;
    backMinutes: number | null;
  } | null;
  week: { evenings: number; backMinutes: number; blockedCalls: number; lastBlockedAt: string | null };
  lateNight: { thisWeek: number; lastWeek: number };
}

export interface ManagerOverview {
  rangeDays: number;
  settings: Settings;
  developers: {
    id: number;
    name: string;
    avgLoad: number;
    load7: number;
    activeHours: number;
    agentHours: number;
    longestStretchMinutes: number;
    lateNightDays: number;
    tasksInProgress: number;
    tasksDone: number;
    gitOnly: boolean;
    hasData: boolean;
  }[];
  allDevelopers: { id: number; name: string }[];
  kpis: { tasksDoneThisWeek: number; medianCycleDays: number | null; activeHours: number; agentHours: number; overloaded: number; developers: number; loadThreshold: number };
  pieByTask: { name: string; hours: number }[];
  pieByDeveloper: { name: string; hours: number }[];
  sankey: { nodes: { name: string; kind: "developer" | "task" | "status" }[]; links: { source: number; target: number; value: number }[] };
  weeklyDone: Record<string, string | number>[];
  cycleTrend: { week: string; medianCycleDays: number | null }[];
  scatter: { developer: string; week: string; hours: number; tasksDone: number }[];
  loadTrend: Record<string, string | number>[];
  hasData: boolean;
}

export interface DeveloperDetail {
  tasks: { key: string; repos: string[]; status: TaskStatus; hours: number; agentHours: number; commits: number; cycleDays: number | null; lastSeen: string }[];
  weekly: { week: string; tasksDone: number; activeHours: number; agentHours: number; avgLoad: number; lateNightMinutes: number }[];
}
