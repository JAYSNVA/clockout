import fs from "node:fs";
import path from "node:path";
import type { JobResult, JobType, SavedRepo, Settings } from "../shared/types.js";
import { paths } from "../shared/paths.js";
import { collect } from "./collect.js";
import { saveOpenWork } from "./git.js";
import { installPause, removePause, resumeTime } from "./pause.js";
import { installPickup } from "./pickup.js";
import { claudeNotes, repoSection, todayByRepo, tomorrowMarkdown } from "./tomorrow.js";

export function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Runs one job on this machine. Used by the in-process local agent, the remote agent and the CLI.
export async function runJob(type: JobType, settings: Settings, now = new Date()): Promise<JobResult> {
  if (type === "resume") return { resumed: removePause() };

  const { payload, local } = await collect(now);
  if (type === "collect") return { payload };

  // Clock out: collect -> save open work -> tomorrow's list -> pause agents -> morning pickup.
  const date = localDate(now);
  const savedRepos: SavedRepo[] = [];
  for (const repo of [...local.recentRepos].sort()) {
    const top = local.repoPaths.get(repo);
    if (top) savedRepos.push(saveOpenWork(top, date, now));
  }

  const until = resumeTime(now, settings.resumeHour);
  const days = todayByRepo(local, savedRepos, now);
  const summary = await claudeNotes(days); // before the pause hook goes in
  const notes = summary?.notes ?? {};
  const pause = installPause(until);
  const tomorrowMd = tomorrowMarkdown(days, date, pause.untilLabel, notes);

  // Tomorrow's first Claude Code session in each repo starts with that repo's notes.
  const pickup = days.flatMap((d) => {
    const repoPath = local.repoPaths.get(d.repo);
    return repoPath ? [{ repo: d.repo, path: repoPath, markdown: repoSection(d, notes[d.repo]) }] : [];
  });
  installPickup(date, pickup, now);

  const dir = paths().tomorrowDir;
  fs.mkdirSync(dir, { recursive: true });
  const tomorrowPath = path.join(dir, `tomorrow-${date}.md`);
  fs.writeFileSync(tomorrowPath, tomorrowMd);

  return {
    payload,
    clockout: {
      date,
      savedRepos: savedRepos.filter((s) => s.status === "saved" || s.reason !== "no uncommitted changes"),
      pauseUntil: pause.until,
      tomorrowPath,
      tomorrowMd,
      usedClaudeSummary: !!summary,
      summarySource: summary?.source ?? null,
      pickupRepos: pickup.map((r) => r.repo),
    },
  };
}
