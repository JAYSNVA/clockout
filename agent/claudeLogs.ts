import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ClaudeEvent } from "../shared/types.js";
import { firstJiraKey } from "../shared/jira.js";

export interface PromptRecord {
  ts: string;
  cwd: string;
  text: string;
  task: string | null;
}

export interface ClaudeLogData {
  events: (ClaudeEvent & { cwd: string })[];
  prompts: PromptRecord[];
}

interface LogLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: unknown };
}

// Tags Claude Code wraps around things the developer typed: slash commands and `!` shell commands.
const TYPED_TAGS = ["<command-name>", "<command-message>", "<bash-input>"];

function userText(line: LogLine): string | null {
  if (line.type !== "user" || line.isSidechain || line.isMeta) return null;
  const content = line.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object");
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  if (text) return text;
  return blocks.some((b) => b.type === "image") ? "[image]" : null;
}

// Text the user actually typed as a prompt. Tool results, slash-command wrappers and
// system-generated messages (command output, reminders, task notifications) are skipped.
export function humanPromptText(line: LogLine): string | null {
  const text = userText(line);
  if (!text || text.startsWith("<")) return null;
  return text;
}

// True when the entry shows the developer at the keyboard: a prompt, a slash command or a `!` command.
export function isHumanActivity(line: LogLine): boolean {
  const text = userText(line);
  if (!text) return false;
  return !text.startsWith("<") || TYPED_TAGS.some((t) => text.startsWith(t));
}

function listLogFiles(claudeDir: string, sinceMs: number): string[] {
  const root = path.join(claudeDir, "projects");
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const full = path.join(dir, f.name);
      if (fs.statSync(full).mtimeMs >= sinceMs) files.push(full);
    }
  }
  return files;
}

// Reads Claude Code session logs and returns one activity event per session per minute,
// marking whether the developer, Claude, or both were active in that minute.
// `repoFor` maps a working directory to a repo name. Sessions run inside `ignoreDir`
// (Clockout's own summary runs) are skipped.
export async function readClaudeLogs(
  claudeDir: string,
  sinceMs: number,
  repoFor: (cwd: string) => string,
  ignoreDir?: string,
): Promise<ClaudeLogData> {
  const events = new Map<string, ClaudeEvent & { cwd: string }>();
  const prompts: PromptRecord[] = [];
  const ignored = ignoreDir ? [ignoreDir, safeRealpath(ignoreDir)] : [];

  for (const file of listLogFiles(claudeDir, sinceMs)) {
    const sessionTask = new Map<string, string>();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.includes('"timestamp"')) continue;
      let line: LogLine;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if ((line.type !== "user" && line.type !== "assistant") || !line.timestamp || !line.sessionId) continue;
      const tsMs = Date.parse(line.timestamp);
      if (Number.isNaN(tsMs) || tsMs < sinceMs) continue;
      const cwd = line.cwd ?? "";
      if (ignored.some((d) => cwd === d || cwd.startsWith(d + path.sep))) continue;

      const prompt = humanPromptText(line);
      if (prompt) {
        const key = firstJiraKey(prompt);
        if (key) sessionTask.set(line.sessionId, key);
      }
      const human = isHumanActivity(line);
      const agent = line.type === "assistant";
      if (!human && !agent) continue; // tool results and system messages

      const task = firstJiraKey(line.gitBranch) ?? sessionTask.get(line.sessionId) ?? null;
      if (prompt) prompts.push({ ts: line.timestamp, cwd, text: prompt, task });
      const minute = new Date(Math.floor(tsMs / 60000) * 60000).toISOString();
      const id = `${line.sessionId}:${minute}`;
      const existing = events.get(id);
      if (!existing) {
        events.set(id, { id, ts: minute, sessionId: line.sessionId, repo: repoFor(cwd), task, human, agent, cwd });
      } else {
        existing.human ||= human;
        existing.agent ||= agent;
        if (!existing.task && task) existing.task = task;
      }
    }
  }

  return {
    events: [...events.values()].sort((a, b) => a.ts.localeCompare(b.ts)),
    prompts: prompts.sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}

function safeRealpath(p: string) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
