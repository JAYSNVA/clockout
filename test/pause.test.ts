import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPause, pauseStatus, removePause, resumeTime } from "../agent/pause";
import { paths } from "../shared/paths";
import { sandbox } from "./helpers";

const settingsFile = () => path.join(paths().claudeDir, "settings.json");
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
const runHook = () => spawnSync("node", [paths().pauseHook], { input: JSON.stringify({ tool_name: "Bash" }), encoding: "utf8" });

describe("pause hook", () => {
  it("keeps existing settings, blocks tool calls while paused and is removed on resume", () => {
    sandbox();
    fs.mkdirSync(paths().claudeDir, { recursive: true });
    const existing = { model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } };
    fs.writeFileSync(settingsFile(), JSON.stringify(existing));

    installPause(new Date(Date.now() + 3600000));
    const s = readSettings();
    expect(s.model).toBe("opus");
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(fs.readdirSync(paths().backups)).toHaveLength(1);
    expect(pauseStatus().paused).toBe(true);

    const blocked = runHook();
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("Clocked out until");
    const log = fs.readFileSync(paths().blockedLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0].tool).toBe("Bash");

    // Clockout's own summary run is never blocked.
    const internal = spawnSync("node", [paths().pauseHook], { input: "{}", encoding: "utf8", env: { ...process.env, CLOCKOUT_INTERNAL: "1" } });
    expect(internal.status).toBe(0);

    expect(removePause()).toBe(true);
    expect(readSettings()).toEqual(existing);
    expect(runHook().status).toBe(0);
  });

  it("removes itself once the resume time has passed", () => {
    sandbox();
    installPause(new Date(Date.now() - 1000));
    expect(readSettings().hooks.PreToolUse).toHaveLength(1);
    expect(runHook().status).toBe(0);
    expect(readSettings().hooks).toBeUndefined();
    expect(fs.existsSync(paths().pauseState)).toBe(false);
  });

  it("resumes on the next workday morning", () => {
    const friday = new Date(2026, 9, 30, 18, 30); // Fri 30 Oct 2026
    expect(resumeTime(friday, 8)).toEqual(new Date(2026, 10, 2, 8, 0)); // Mon
    const lateTuesday = new Date(2026, 9, 28, 1, 30); // Wed 01:30 is still "last night"
    expect(resumeTime(lateTuesday, 8)).toEqual(new Date(2026, 9, 28, 8, 0));
  });
});
