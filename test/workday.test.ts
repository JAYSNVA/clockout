import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runJob } from "../agent/runner";
import { openDb, run } from "../server/db";
import { runSchedule } from "../server/scheduler";
import { completeJob, createDeveloper, ensureLocalDevice, jobById, linkLocalDevice, setWorkday } from "../server/store";
import { paths } from "../shared/paths";
import { DEFAULT_SETTINGS } from "../shared/types";
import { author, commit, makeRepo, sandbox, todayAt, writeClaudeSession } from "./helpers";

const wed = (h: number, m = 0) => new Date(2026, 9, 28, h, m); // Wednesday 28 Oct 2026

function setup() {
  const db = openDb(":memory:");
  const dev = createDeveloper(db, "Ana", []);
  ensureLocalDevice(db, "laptop");
  linkLocalDevice(db, dev.id);
  return { db, dev };
}

describe("end-of-workday schedule", () => {
  it("runs once per weekday, at or after the end time, within 3 hours", () => {
    const { db, dev } = setup();
    expect(runSchedule(db, wed(18, 35))).toEqual([]); // off by default
    setWorkday(db, dev.id, { mode: "wrapup", endTime: "18:30" });

    expect(runSchedule(db, wed(18, 29))).toEqual([]);
    const [id] = runSchedule(db, wed(18, 30));
    expect(jobById(db, id)!.type).toBe("auto-wrapup");
    expect(runSchedule(db, wed(18, 45))).toEqual([]); // once per day

    expect(runSchedule(db, new Date(2026, 9, 29, 21, 31))).toEqual([]); // Thursday, window over
    expect(runSchedule(db, new Date(2026, 9, 31, 18, 40))).toEqual([]); // Saturday
    setWorkday(db, dev.id, { mode: "clockout" });
    const [fri] = runSchedule(db, new Date(2026, 9, 30, 19, 0));
    expect(jobById(db, fri)!.type).toBe("auto-clockout");
  });

  it("skips developers who already clocked out today", () => {
    const { db, dev } = setup();
    setWorkday(db, dev.id, { mode: "clockout", endTime: "18:00" });
    run(db, "INSERT INTO clockouts (user_id, date, created_at, result_json) VALUES (?, ?, ?, ?)", dev.id, "2026-10-28", wed(17, 40).toISOString(), "{}");
    expect(runSchedule(db, wed(18, 5))).toEqual([]);
  });

  it("validates the setting and records skipped runs without a clock-out", () => {
    const { db, dev } = setup();
    expect(() => setWorkday(db, dev.id, { endTime: "25:00" })).toThrow();
    setWorkday(db, dev.id, { mode: "wrapup", endTime: "18:00" });
    const [id] = runSchedule(db, wed(18, 0));
    completeJob(db, id, { skipped: "no activity from you today" });
    expect(jobById(db, id)).toMatchObject({ status: "done", error: "Skipped: no activity from you today" });
  });
});

describe("end-of-workday run on the developer's machine", () => {
  it("wrap-up saves work and writes the list but leaves agents running; pickup waits for the morning", async () => {
    const { code, claudeDir } = sandbox();
    const repo = makeRepo(path.join(code, "api"));
    commit(repo, "a.txt", "1", "init", author("Dev", "dev@example.com", todayAt(8)));
    fs.writeFileSync(path.join(repo, "wip.txt"), "half done\n");
    writeClaudeSession(claudeDir, { sessionId: "s1", cwd: repo, start: todayAt(9), end: todayAt(10), prompt: "add retries", promptEvery: 10 });

    const result = await runJob("auto-wrapup", DEFAULT_SETTINGS, todayAt(23));
    expect(result.clockout).toMatchObject({ pauseUntil: null, auto: true, pickupRepos: ["api"] });
    expect(result.clockout!.savedRepos[0]).toMatchObject({ repo: "api", status: "saved" });
    expect(result.clockout!.tomorrowMd).toContain("Agents were not paused.");
    expect(fs.existsSync(paths().pauseState)).toBe(false);
    const pickup = JSON.parse(fs.readFileSync(paths().pickupState, "utf8"));
    expect(Date.parse(pickup.notBefore)).toBeGreaterThan(todayAt(23).getTime());
  });

  it("does nothing on a day you didn't work", async () => {
    sandbox();
    const result = await runJob("auto-clockout", DEFAULT_SETTINGS, todayAt(18));
    expect(result.skipped).toBe("no activity from you today");
    expect(result.clockout).toBeUndefined();
    expect(fs.existsSync(paths().pauseState)).toBe(false);
  });
});
