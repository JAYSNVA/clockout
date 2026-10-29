import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPause } from "../agent/pause";
import { removeClaude, setupClaude } from "../agent/setup";
import { paths } from "../shared/paths";
import { sandbox, writeClaudeSession } from "./helpers";

const settingsFile = () => path.join(paths().claudeDir, "settings.json");
const statusline = () =>
  spawnSync("node", [path.join(paths().clockoutHome, "statusline.mjs")], { input: JSON.stringify({ session_id: "x" }), encoding: "utf8" }).stdout.trim();
const minutesAgo = (m: number) => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return new Date(Math.max(Date.now() - m * 60000, midnight.getTime() + 60000));
};

describe("Claude Code setup", () => {
  it("adds the status line and the /clockout commands, and removes only its own entries", () => {
    sandbox();
    fs.mkdirSync(paths().claudeDir, { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: "opus" }));

    setupClaude();
    const settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.statusLine.command).toContain("statusline.mjs");
    const skill = fs.readFileSync(path.join(paths().claudeDir, "skills", "clockout", "SKILL.md"), "utf8");
    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).toMatch(/!`npm --prefix .+ run --silent clockout`/);
    expect(skill).toMatch(/allowed-tools: Bash\(npm --prefix .+ run --silent clockout\)/);

    expect(removeClaude()).toEqual(["/clockout", "/clockout-resume", "status line"]);
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))).toEqual({ model: "opus" });
    expect(fs.existsSync(path.join(paths().claudeDir, "skills", "clockout"))).toBe(false);
  });

  it("never replaces a status line you already have", () => {
    sandbox();
    fs.mkdirSync(paths().claudeDir, { recursive: true });
    const mine = { type: "command", command: "~/my-statusline.sh" };
    fs.writeFileSync(settingsFile(), JSON.stringify({ statusLine: mine }));
    expect(setupClaude().join("\n")).toContain("kept your existing one");
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).statusLine).toEqual(mine);
    removeClaude();
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).statusLine).toEqual(mine);
  });
});

describe("status line", () => {
  it("shows your hands-on time and time since your last break, and updates as logs grow", () => {
    const { code, claudeDir } = sandbox();
    setupClaude();
    expect(statusline()).toBe("Clockout · no prompts from you yet today");

    writeClaudeSession(claudeDir, { sessionId: "s1", cwd: code, start: minutesAgo(90), end: minutesAgo(60), promptEvery: 5 });
    expect(statusline()).toMatch(/^Clockout · \d+m hands-on today · on a break since \d\d:\d\d$/);

    // You're back: new prompts appended to the same log.
    writeClaudeSession(claudeDir, { sessionId: "s1", cwd: code, start: minutesAgo(20), end: minutesAgo(1), promptEvery: 4 });
    expect(statusline()).toMatch(/^Clockout · \d+m hands-on today · \d+m since your last break$/);
  });

  it("says when you're clocked out", () => {
    sandbox();
    setupClaude();
    installPause(new Date(Date.now() + 3600000));
    expect(statusline()).toMatch(/^Clockout · clocked out until /);
  });
});
