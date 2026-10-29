// npm run setup-claude: adds Clockout to Claude Code.
//   - a status line: your hands-on time today and time since your last break
//   - /clockout: clock out without leaving Claude Code
//   - /clockout-resume: unblock tools early
// npm run setup-claude -- --remove takes all of it out again.
// An existing status line of your own is never replaced.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../shared/paths.js";
import { editSettings, hookCommand, installHookScript } from "./hooks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quote = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
const npmRun = (script: string) => `npm --prefix ${quote(root)} run --silent ${script}`;

const SKILLS: Record<string, string> = {
  clockout: `---
name: clockout
description: End the workday with Clockout - save open work to a clockout branch, write tomorrow's list and pause Claude Code agents until morning.
disable-model-invocation: true
effort: low
allowed-tools: Bash(${npmRun("clockout")})
---

Clockout just ran for the developer:

!\`${npmRun("clockout")}\`

Tell them in two or three short lines what was saved, where tomorrow's list is and until when agents are paused.
Don't run any tools: they are paused now.
`,
  "clockout-resume": `---
name: clockout-resume
description: Resume Claude Code after clocking out with Clockout, before the pause ends on its own.
disable-model-invocation: true
effort: low
allowed-tools: Bash(${npmRun("resume")})
---

!\`${npmRun("resume")}\`

Confirm in one line whether tools are unblocked. If the command was blocked, tell the developer to run \`${npmRun("resume")}\` in a terminal.
`,
};

export function setupClaude() {
  const p = paths();
  const changes: string[] = [];
  for (const [name, body] of Object.entries(SKILLS)) {
    const dir = path.join(p.claudeDir, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
    changes.push(`/${name} command: ${path.join(dir, "SKILL.md")}`);
  }

  const script = path.join(p.clockoutHome, "statusline.mjs");
  installHookScript("statusline.mjs", script);
  fs.writeFileSync(path.join(p.clockoutHome, "statusline-config.json"), JSON.stringify({ claudeDir: p.claudeDir }));
  const command = hookCommand(script);
  let kept = false;
  editSettings((s) => {
    if (s.statusLine && s.statusLine.command !== command) {
      kept = true;
      return false;
    }
    if (s.statusLine?.command === command) return false;
    s.statusLine = { type: "command", command, padding: 0 };
    return true;
  });
  changes.push(
    kept
      ? `status line: kept your existing one. To use Clockout's, set "statusLine": {"type": "command", "command": ${JSON.stringify(command)}}`
      : `status line: ${command}`,
  );
  return changes;
}

export function removeClaude() {
  const p = paths();
  const removed: string[] = [];
  for (const name of Object.keys(SKILLS)) {
    const dir = path.join(p.claudeDir, "skills", name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(`/${name}`);
    }
  }
  const command = hookCommand(path.join(p.clockoutHome, "statusline.mjs"));
  if (editSettings((s) => (s.statusLine?.command === command ? (delete s.statusLine, true) : false))) removed.push("status line");
  return removed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes("--remove")) {
    const removed = removeClaude();
    console.log(removed.length ? `Removed from Claude Code: ${removed.join(", ")}.` : "Nothing to remove.");
  } else {
    console.log("Added to Claude Code:");
    for (const c of setupClaude()) console.log(`  ${c}`);
    console.log("\nRestart Claude Code (or start a new session) to see them. Undo with: npm run setup-claude -- --remove");
  }
}
