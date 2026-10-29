import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPause, removePause } from "../agent/pause";
import { installPickup, pickupStatus } from "../agent/pickup";
import { paths } from "../shared/paths";
import { sandbox } from "./helpers";

const settings = () => JSON.parse(fs.readFileSync(path.join(paths().claudeDir, "settings.json"), "utf8"));
const start = (cwd: string, source = "startup", env: NodeJS.ProcessEnv = {}) => {
  const res = spawnSync("node", [paths().pickupHook], { input: JSON.stringify({ hook_event_name: "SessionStart", source, cwd }), encoding: "utf8", env: { ...process.env, ...env } });
  expect(res.status).toBe(0);
  return res.stdout ? (JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string) : null;
};

describe("morning pickup hook", () => {
  it("gives the first new session in each repo that repo's notes, once, and then removes itself", () => {
    const { code } = sandbox();
    const api = path.join(code, "api");
    const web = path.join(code, "web");
    fs.mkdirSync(path.join(api, "src"), { recursive: true });
    fs.mkdirSync(web, { recursive: true });
    installPickup("2026-10-29", [
      { repo: "api", path: api, markdown: "## api — PAY-3\n\n- **Where you left off:** retries half done" },
      { repo: "web", path: web, markdown: "## web\n\n- **Uncommitted files (1):** `a.ts`" },
    ]);
    expect(settings().hooks.SessionStart[0].matcher).toBe("startup");

    // While clocked out, nothing is handed over yet.
    installPause(new Date(Date.now() + 3600000));
    expect(start(path.join(api, "src"))).toBeNull();
    removePause();

    expect(start(code)).toBeNull(); // not inside a saved repo
    expect(start(api, "resume")).toBeNull(); // resumed sessions already have their context
    expect(start(api, "startup", { CLOCKOUT_INTERNAL: "1" })).toBeNull();

    const context = start(path.join(api, "src"));
    expect(context).toContain("retries half done");
    expect(context).toContain("clocked out on 2026-10-29");
    expect(start(api)).toBeNull(); // only once per repo
    expect(pickupStatus()!.repos.find((r) => r.repo === "api")!.pickedUpAt).toBeTruthy();

    expect(start(web)).toContain("a.ts");
    expect(settings().hooks).toBeUndefined(); // every repo picked up: hook removed
  });

  it("expires after 4 days", () => {
    const { code } = sandbox();
    installPickup("2026-10-20", [{ repo: "api", path: code, markdown: "old" }], new Date(Date.now() - 5 * 86400000));
    expect(start(code)).toBeNull();
    expect(settings().hooks).toBeUndefined();
  });
});
