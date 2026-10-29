// `npm run clockout` and `npm run resume`.
// Uses the running Clockout server when there is one, so the dashboard stays in sync.
// Without a server, runs the same steps directly on this machine.
import fs from "node:fs";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import type { ClockoutResult, JobType } from "../shared/types.js";
import { paths } from "../shared/paths.js";
import { removePause } from "./pause.js";
import { runJob } from "./runner.js";

const type = process.argv[2] as JobType;
if (type !== "clockout" && type !== "resume") {
  console.error("Usage: tsx agent/cli.ts clockout|resume");
  process.exit(1);
}

function printClockout(c: ClockoutResult) {
  const saved = c.savedRepos.filter((s) => s.status === "saved");
  const until = c.pauseUntil && new Date(c.pauseUntil).toLocaleString([], { weekday: "long", hour: "2-digit", minute: "2-digit" });
  console.log(until ? `\nClocked out. Claude Code tools are paused until ${until}.` : "\nWrapped up. Tomorrow's list is written; agents were not paused.");
  if (saved.length === 0) console.log("  No uncommitted work to save.");
  for (const s of saved) console.log(`  saved ${s.repo} -> ${s.branch} (${s.files} files)`);
  for (const s of c.savedRepos.filter((s) => s.status === "skipped")) console.log(`  skipped ${s.repo}: ${s.reason}`);
  if (c.prunedBranches) console.log(`  removed ${c.prunedBranches} old clockout/* branches`);
  console.log(`  Tomorrow's list: ${c.tomorrowPath}`);
  if (c.pickupRepos.length) console.log(`  Tomorrow's first Claude Code session in ${c.pickupRepos.join(", ")} starts with these notes.`);
  console.log("");
}

async function viaServer(): Promise<boolean> {
  const file = paths().localDevice;
  if (!fs.existsSync(file)) return false;
  const { token, server } = JSON.parse(fs.readFileSync(file, "utf8"));
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  let res: Response;
  try {
    res = await fetch(`${server}/api/agent/jobs`, { method: "POST", headers, body: JSON.stringify({ type }) });
  } catch {
    return false; // server not running
  }
  const data = (await res.json()) as { job?: { id: number }; error?: string };
  if (!res.ok || !data.job) {
    console.error(data.error ?? `Server error ${res.status}`);
    return false;
  }
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await fetch(`${server}/api/agent/jobs/${data.job.id}`, { headers });
    const { job, clockout } = (await poll.json()) as { job: { status: string; error?: string }; clockout?: ClockoutResult | null };
    if (job.status === "done") {
      if (type === "resume") console.log("Resumed. Claude Code tools are unblocked.");
      else if (clockout) printClockout(clockout);
      else console.log("Clocked out. See the summary in the Clockout dashboard.");
      return true;
    }
    if (job.status === "failed") {
      console.error(`Failed: ${job.error}`);
      process.exit(1);
    }
  }
  console.error("Timed out waiting for the Clockout server.");
  process.exit(1);
}

if (type === "resume") {
  // Unblock immediately, even if the server is down.
  const was = removePause();
  if (!(await viaServer())) console.log(was ? "Resumed. Claude Code tools are unblocked." : "Nothing to resume: agents were not paused.");
} else if (!(await viaServer())) {
  console.log("Clockout server not running: clocking out directly on this machine.");
  printClockout(await clockOutWithoutServer());
}

// Uses your Clockout settings (resume hour) and records the clock-out in the database, so the
// dashboard shows it next time it starts. Without a database, runs with the defaults.
async function clockOutWithoutServer(): Promise<ClockoutResult> {
  if (!fs.existsSync(paths().db)) return (await runJob("clockout", DEFAULT_SETTINGS)).clockout!;
  const { openDb } = await import("../server/db.js");
  const { completeJob, createJob, getSettings, localDevice } = await import("../server/store.js");
  const db = openDb(paths().db);
  try {
    const result = await runJob("clockout", getSettings(db));
    const userId = localDevice(db)?.user_id;
    if (userId) completeJob(db, createJob(db, userId, "clockout").id, result);
    return result.clockout!;
  } finally {
    db.close();
  }
}
