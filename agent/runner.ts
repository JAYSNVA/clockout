import fs from "node:fs";
import path from "node:path";
import type { JobResult, JobType, SavedRepo, Settings } from "../shared/types.js";
import { paths } from "../shared/paths.js";
import { collect } from "./collect.js";
import { pruneClockoutBranches, saveOpenWork } from "./git.js";
import { installPause, removePause, resumeTime } from "./pause.js";
import { installPickup } from "./pickup.js";
import { claudeNotes, repoSection, todayByRepo, tomorrowMarkdown } from "./tomorrow.js";

export function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function workedToday(local: { prompts: { ts: string }[]; commits: { ts: string; email: string }[]; localEmails: string[] }, now: Date) {
  const today = localDate(now);
  return (
    local.prompts.some((p) => localDate(new Date(p.ts)) === today) ||
    local.commits.some((c) => local.localEmails.includes(c.email) && localDate(new Date(c.ts)) === today)
  );
}

// Runs one job on this machine. Used by the in-process local agent, the remote agent and the CLI.
export async function runJob(type: JobType, settings: Settings, now = new Date()): Promise<JobResult> {
  if (type === "resume") return { resumed: removePause() };

  const { payload, local } = await collect(now);
  if (type === "collect") return { payload };

  // Clock out: collect -> save open work -> tomorrow's list -> pause agents -> morning pickup.
  // The end-of-workday schedule runs the same steps; "auto-wrapup" leaves agents running.
  const auto = type === "auto-clockout" || type === "auto-wrapup";
  const pauseAgents = type !== "auto-wrapup";
  const date = localDate(now);
  if (auto && !workedToday(local, now)) return { payload, skipped: "no activity from you today" };
  const savedRepos: SavedRepo[] = [];
  for (const repo of [...local.recentRepos].sort()) {
    const top = local.repoPaths.get(repo);
    if (top) savedRepos.push(saveOpenWork(top, date, now, repo));
  }

  const keepDays = Number(process.env.CLOCKOUT_KEEP_DAYS || 14);
  let prunedBranches = 0;
  for (const top of new Set(local.repoPaths.values())) prunedBranches += pruneClockoutBranches(top, keepDays, now).length;

  const until = resumeTime(now, settings.resumeHour);
  const days = todayByRepo(local, savedRepos, now);
  const summary = await claudeNotes(days); // before the pause hook goes in
  const notes = summary?.notes ?? {};
  const pause = pauseAgents ? installPause(until) : null;
  const tomorrowMd = tomorrowMarkdown(days, date, pause?.untilLabel ?? null, notes);

  // Tomorrow's first Claude Code session in each repo starts with that repo's notes.
  const pickup = days.flatMap((d) => {
    const repoPath = local.repoPaths.get(d.repo);
    return repoPath ? [{ repo: d.repo, path: repoPath, markdown: repoSection(d, notes[d.repo]) }] : [];
  });
  installPickup(date, pickup, now, until);

  const dir = paths().tomorrowDir;
  fs.mkdirSync(dir, { recursive: true });
  const tomorrowPath = path.join(dir, `tomorrow-${date}.md`);
  fs.writeFileSync(tomorrowPath, tomorrowMd);

  return {
    payload,
    clockout: {
      date,
      savedRepos: savedRepos.filter((s) => s.status === "saved" || s.reason !== "no uncommitted changes"),
      pauseUntil: pause?.until ?? null,
      auto,
      tomorrowPath,
      tomorrowMd,
      usedClaudeSummary: !!summary,
      summarySource: summary?.source ?? null,
      pickupRepos: pickup.map((r) => r.repo),
      prunedBranches,
    },
  };
}
