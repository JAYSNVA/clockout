import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { CollectPayload, TaskDone } from "../shared/types.js";
import { paths } from "../shared/paths.js";
import { readClaudeLogs, type PromptRecord } from "./claudeLogs.js";
import { findRepos, readCommits, readTaskDone, repoName, repoToplevel, type RepoCommit } from "./git.js";

export const COLLECT_DAYS = 45;

// Local-only details used for tomorrow's list and WIP saving. Never sent to managers.
export interface LocalDetails {
  repoPaths: Map<string, string>; // repo name -> toplevel path
  prompts: PromptRecord[];
  commits: RepoCommit[];
  localEmails: string[];
  recentRepos: Set<string>; // repos with local activity in the last 7 days
}

export interface CollectOutput {
  payload: CollectPayload;
  local: LocalDetails;
}

function gitGlobalEmail(): string[] {
  try {
    const email = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8" }).trim().toLowerCase();
    return email ? [email] : [];
  } catch {
    return [];
  }
}

// Timestamps of tool calls the pause hook blocked. Tool names and inputs stay on this machine.
function readBlockedCalls(file: string, since: Date): string[] {
  if (!fs.existsSync(file)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const ts = JSON.parse(line).ts as string;
      if (ts && ts >= since.toISOString()) out.push(ts);
    } catch {
      // partial or empty line
    }
  }
  return out;
}

export async function collect(now = new Date()): Promise<CollectOutput> {
  const p = paths();
  const since = new Date(now.getTime() - COLLECT_DAYS * 86400000);
  const repoPaths = new Map<string, string>();

  const repoFor = (cwd: string) => {
    const top = repoToplevel(cwd);
    if (top) {
      repoPaths.set(repoName(top), top);
      return repoName(top);
    }
    return cwd ? path.basename(cwd) : "unknown";
  };

  const logs = await readClaudeLogs(p.claudeDir, since.getTime(), repoFor, p.clockoutHome);
  for (const top of findRepos(p.scanRoots)) repoPaths.set(repoName(top), top);

  const commits: RepoCommit[] = [];
  const tasks: TaskDone[] = [];
  for (const top of repoPaths.values()) {
    commits.push(...readCommits(top, since));
    tasks.push(...readTaskDone(top, since));
  }

  const localEmails = gitGlobalEmail();
  for (const top of repoPaths.values()) {
    try {
      const e = execFileSync("git", ["config", "user.email"], { cwd: top, encoding: "utf8" }).trim().toLowerCase();
      if (e && !localEmails.includes(e)) localEmails.push(e);
    } catch {
      // no repo-level email
    }
  }

  const weekAgo = now.getTime() - 7 * 86400000;
  const blockedCalls = readBlockedCalls(p.blockedLog, since);
  const recentRepos = new Set<string>();
  for (const e of logs.events) if (Date.parse(e.ts) >= weekAgo) recentRepos.add(e.repo);
  for (const c of commits) if (Date.parse(c.ts) >= weekAgo && localEmails.includes(c.email)) recentRepos.add(c.repo);

  return {
    payload: {
      deviceName: os.hostname(),
      collectedAt: now.toISOString(),
      localEmails,
      claudeEvents: logs.events.map(({ cwd: _cwd, ...e }) => e),
      commits: commits.map(({ subject: _s, ...c }) => c),
      tasks,
      blockedCalls,
    },
    local: { repoPaths, prompts: logs.prompts, commits, localEmails, recentRepos },
  };
}
