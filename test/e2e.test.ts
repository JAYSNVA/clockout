import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../shared/paths";
import { buildApp } from "../server/app";
import { openDb } from "../server/db";
import { startLocalAgent } from "../server/localAgent";
import { ensureLocalDevice } from "../server/store";
import { author, commit, makeRepo, sandbox, sh, todayAt, writeClaudeSession } from "./helpers";

describe("end to end: login -> collect -> manager charts -> clock out -> resume", () => {
  it("works with real logs and git repos", async () => {
    const { code, claudeDir } = sandbox();
    const days2 = (n: number) => new Date(Date.now() - n * 86400000);

    // A shared repo with commits by Ana (local developer) and Ben (teammate).
    const repo = makeRepo(path.join(code, "payments"));
    sh(repo, ["config", "user.email", "ana@example.com"]);
    commit(repo, "a.txt", "1", "init", author("Ana", "ana@example.com", days2(5)));
    sh(repo, ["checkout", "-q", "-b", "PAY-1-refunds"]);
    commit(repo, "r.txt", "1", "PAY-1 refunds api", author("Ana", "ana@example.com", days2(4)));
    sh(repo, ["checkout", "-q", "main"]);
    sh(repo, ["merge", "-q", "--no-ff", "PAY-1-refunds", "-m", "Merge PAY-1-refunds"], author("Ana", "ana@example.com", days2(3)));
    commit(repo, "b.txt", "1", "PAY-2 currency rounding", author("Ben", "ben@example.com", todayAt(11)));
    sh(repo, ["checkout", "-q", "-b", "PAY-3-webhooks"]);
    fs.writeFileSync(path.join(repo, "wip.txt"), "half done\n");

    // Ana's Claude Code sessions today: two in parallel, then an agent run she leaves alone.
    writeClaudeSession(claudeDir, { sessionId: "s1", cwd: repo, start: todayAt(9), end: todayAt(10, 30), gitBranch: "PAY-3-webhooks", prompt: "add retry to webhooks", promptEvery: 10 });
    writeClaudeSession(claudeDir, { sessionId: "s2", cwd: repo, start: todayAt(9, 30), end: todayAt(10), gitBranch: "main", prompt: "PAY-2 check the rounding", promptEvery: 10 });
    writeClaudeSession(claudeDir, { sessionId: "s3", cwd: repo, start: todayAt(13), end: todayAt(14), gitBranch: "PAY-3-webhooks", prompt: "write the webhook docs" });
    // Three earlier evenings that ran late, so there is a usual finish to compare with.
    for (const n of [2, 3, 4]) {
      const evening = new Date(todayAt(20).getTime() - n * 86400000);
      writeClaudeSession(claudeDir, { sessionId: `e${n}`, cwd: repo, start: evening, end: new Date(evening.getTime() + 90 * 60000), gitBranch: "PAY-3-webhooks", prompt: "keep going", promptEvery: 10 });
    }

    const db = openDb(":memory:");
    ensureLocalDevice(db, "test-machine");
    const agent = startLocalAgent(db, 60_000);
    const app = buildApp({ db });
    const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `clockout_session=${res.cookies.find((c) => c.name === "clockout_session")!.value}`;

    // Ana signs in on this machine: local agent links to her and collects.
    const anaLogin = await app.inject({ method: "POST", url: "/api/login", payload: { name: "Ana", role: "developer" } });
    expect(anaLogin.statusCode).toBe(200);
    const ana = cookieOf(anaLogin);
    await agent.tick();

    const overview = (await app.inject({ method: "GET", url: "/api/me/overview", headers: { cookie: ana } })).json();
    expect(overview.hasData).toBe(true);
    expect(overview.today.activeMinutes).toBe(95); // 09:00-10:30 plus the single 13:00 prompt
    expect(overview.today.agentSoloMinutes).toBeGreaterThanOrEqual(50); // the 13:00 agent run on its own
    expect(overview.today.peakParallelSessions).toBe(2);
    expect(overview.tasks.map((t: { key: string }) => t.key).sort()).toEqual(["PAY-1", "PAY-2", "PAY-3"]);
    const statusOf = (k: string) => overview.tasks.find((t: { key: string }) => t.key === k).status;
    expect(statusOf("PAY-1")).toBe("Done"); // merged branch
    expect(statusOf("PAY-2")).toBe("Done"); // committed on main
    expect(statusOf("PAY-3")).toBe("In progress"); // new branch, nothing merged
    expect(overview.emails).toContain("ana@example.com");

    // Ben signs in from another browser and claims his git email.
    const ben = cookieOf(await app.inject({ method: "POST", url: "/api/login", payload: { name: "Ben", role: "developer" } }));
    await app.inject({ method: "PUT", url: "/api/me/emails", headers: { cookie: ben }, payload: { emails: ["ben@example.com"] } });
    const benView = (await app.inject({ method: "GET", url: "/api/me/overview", headers: { cookie: ben } })).json();
    expect(benView.today.source).toBe("git-only");
    expect(benView.today.commits).toBe(1);

    // One manager only.
    const mgr = cookieOf(await app.inject({ method: "POST", url: "/api/login", payload: { name: "Maya", role: "manager" } }));
    const second = await app.inject({ method: "POST", url: "/api/login", payload: { name: "Omar", role: "manager" } });
    expect(second.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/manager/overview", headers: { cookie: ana } })).statusCode).toBe(403);

    const team = (await app.inject({ method: "GET", url: "/api/manager/overview?days=14", headers: { cookie: mgr } })).json();
    expect(team.developers.map((d: { name: string }) => d.name)).toEqual(["Ana", "Ben"]);
    expect(team.pieByTask.length).toBeGreaterThan(0);
    expect(team.pieByDeveloper.map((d: { name: string }) => d.name).sort()).toEqual(["Ana", "Ben"]);
    expect(team.sankey.links.length).toBeGreaterThan(0);
    expect(team.weeklyDone.some((w: Record<string, number>) => w.Ana >= 1)).toBe(true);
    expect(team.weeklyDone.some((w: Record<string, number>) => w.Ben === 1)).toBe(true);
    expect(team.loadTrend).toHaveLength(14);

    // Ana clocks out from the dashboard.
    const job = (await app.inject({ method: "POST", url: "/api/jobs", headers: { cookie: ana }, payload: { type: "clockout" } })).json().job;
    await agent.tick();
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: { cookie: ana } })).json().job.status).toBe("done");

    const after = (await app.inject({ method: "GET", url: "/api/me/overview", headers: { cookie: ana } })).json();
    expect(after.paused).toBe(true);
    const saved = after.clockout.savedRepos.find((s: { repo: string }) => s.repo === "payments");
    expect(saved.status).toBe("saved");
    expect(sh(repo, ["show", `${saved.branch}:wip.txt`])).toBe("half done");
    expect(sh(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("PAY-3-webhooks");
    expect(after.clockout.tomorrowMd).toContain("write the webhook docs"); // last prompt on PAY-3
    expect(after.clockout.tomorrowMd).toContain("PAY-2 check the rounding");
    expect(fs.existsSync(after.clockout.tomorrowPath)).toBe(true);
    const settingsFile = path.join(paths().claudeDir, "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(after.clockout.pickupRepos).toEqual(["payments"]);
    expect(after.timeBack.last).not.toBeNull();
    expect(after.timeBack.usualFinishMinutes).not.toBeNull();

    // A late-night agent tries a tool call: blocked, and counted on the next collect.
    const blocked = spawnSync("node", [paths().pauseHook], { input: JSON.stringify({ tool_name: "Edit" }), encoding: "utf8" });
    expect(blocked.status).toBe(2);
    await app.inject({ method: "POST", url: "/api/jobs", headers: { cookie: ana }, payload: { type: "collect" } });
    await agent.tick();
    const counted = (await app.inject({ method: "GET", url: "/api/me/overview", headers: { cookie: ana } })).json();
    expect(counted.timeBack.week.blockedCalls).toBe(1);

    // The manager never sees prompts or tomorrow's list.
    const mgrJson = (await app.inject({ method: "GET", url: "/api/manager/overview", headers: { cookie: mgr } })).body
      + (await app.inject({ method: "GET", url: `/api/manager/developers/${anaLogin.json().user.id}`, headers: { cookie: mgr } })).body;
    expect(mgrJson).not.toContain("add retry");
    expect(mgrJson).not.toContain("webhook docs");
    expect(mgrJson).not.toContain("tomorrow");

    // Resume removes the hook.
    await app.inject({ method: "POST", url: "/api/jobs", headers: { cookie: ana }, payload: { type: "resume" } });
    await agent.tick();
    const resumed = (await app.inject({ method: "GET", url: "/api/me/overview", headers: { cookie: ana } })).json();
    expect(resumed.paused).toBe(false);
    const hooksAfterResume = JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks;
    expect(hooksAfterResume.PreToolUse).toBeUndefined();
    expect(hooksAfterResume.SessionStart).toHaveLength(1);

    // Next morning: the first Claude Code session in the repo starts with yesterday's notes.
    const pickup = spawnSync("node", [paths().pickupHook], { input: JSON.stringify({ source: "startup", cwd: repo }), encoding: "utf8" });
    expect(JSON.parse(pickup.stdout).hookSpecificOutput.additionalContext).toContain("write the webhook docs");
    expect(JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks).toBeUndefined();

    agent.stop();
    await app.close();
  });
});
