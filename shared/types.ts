// Data the collector agent sends to the server. Contains no prompt text, code,
// file names or commit messages: only timestamps, repo names and Jira keys.
export interface ClaudeEvent {
  id: string; // `${sessionId}:${minute ISO}`
  ts: string;
  sessionId: string;
  repo: string;
  task: string | null;
  human: boolean; // the developer typed a prompt or command in this minute
  agent: boolean; // Claude produced output in this minute
}

export interface CommitEvent {
  sha: string;
  ts: string;
  email: string;
  name: string;
  repo: string;
  task: string | null;
  onDefault: boolean;
}

export interface TaskDone {
  key: string;
  repo: string;
  doneAt: string | null;
}

export interface CollectPayload {
  deviceName: string;
  collectedAt: string;
  localEmails: string[];
  claudeEvents: ClaudeEvent[];
  commits: CommitEvent[];
  tasks: TaskDone[];
  blockedCalls: string[]; // timestamps of tool calls the pause hook blocked
  timeZone?: string; // IANA zone of the developer's machine, e.g. "Europe/Dublin"
}

export interface SavedRepo {
  repo: string;
  path: string;
  status: "saved" | "skipped";
  branch?: string;
  files?: number;
  reason?: string;
}

export interface ClockoutResult {
  date: string;
  savedRepos: SavedRepo[];
  pauseUntil: string | null; // null when the end-of-workday run only wrote tomorrow's list
  auto?: boolean; // run by the end-of-workday schedule
  tomorrowPath: string;
  tomorrowMd: string;
  usedClaudeSummary: boolean;
  summarySource: "api" | "claude-code" | null;
  pickupRepos: string[]; // repos whose next Claude Code session starts with these notes
  prunedBranches?: number; // old clockout/* branches removed
}

// auto-* jobs come from the developer's end-of-workday schedule.
export type JobType = "collect" | "clockout" | "resume" | "auto-clockout" | "auto-wrapup";

export interface JobResult {
  payload?: CollectPayload;
  clockout?: ClockoutResult;
  resumed?: boolean;
  skipped?: string; // an auto job that had nothing to do
}

export interface Settings {
  jiraBaseUrl: string;
  lateHour: number;
  resumeHour: number;
  loadThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  jiraBaseUrl: "",
  lateHour: 20,
  resumeHour: 8,
  loadThreshold: 60,
};
