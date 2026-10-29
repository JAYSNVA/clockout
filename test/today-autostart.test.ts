import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchdPlist, serviceSpec, systemdUnit } from "../agent/autostart";
import { todayReport } from "../agent/today";
import { author, commit, makeRepo, sandbox, todayAt, writeClaudeSession } from "./helpers";

describe("npm run today", () => {
  it("reports your day from local logs and commits, with no server", async () => {
    const { code, claudeDir } = sandbox();
    process.env.GIT_CONFIG_GLOBAL = path.join(code, "..", "gitconfig");
    const repo = makeRepo(path.join(code, "api"));
    commit(repo, "a.txt", "1", "PAY-7 add retries", author("Dev", "dev@example.com", todayAt(10, 15)));
    writeClaudeSession(claudeDir, { sessionId: "s1", cwd: repo, start: todayAt(9), end: todayAt(10, 30), gitBranch: "PAY-7-retries", promptEvery: 5 });
    const now = todayAt(23, 59);

    const report = await todayReport(now);
    expect(report).toContain("You, today");
    expect(report).toMatch(/You, today\s+1h 30m/);
    expect(report).toMatch(/PAY-7\s+1h 30m you/);
    expect(report).toContain("Last 7 days");
    expect(report).toContain("dev@example.com");
    delete process.env.GIT_CONFIG_GLOBAL;
  });

  it("says so when there's nothing yet", async () => {
    sandbox();
    expect(await todayReport()).toContain("No prompts or commits from you yet today.");
  });
});

describe("npm run autostart", () => {
  it("writes a launchd agent and a systemd unit that run the server without opening a browser", () => {
    sandbox();
    process.env.PORT = "4555";
    const spec = serviceSpec();
    delete process.env.PORT;
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>--import</string>");
    expect(plist).toContain(path.join("server", "index.ts"));
    expect(plist).toMatch(/<key>CLOCKOUT_NO_OPEN<\/key><string>1<\/string>/);
    expect(plist).toMatch(/<key>PORT<\/key><string>4555<\/string>/);
    expect(plist).not.toContain("ANTHROPIC_API_KEY");
    const unit = systemdUnit(spec);
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain('Environment="CLOCKOUT_NO_OPEN=1"');
  });
});
