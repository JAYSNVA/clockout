#!/usr/bin/env node
// Clockout morning pickup hook for Claude Code (SessionStart).
// When a new Claude Code session starts inside a repo you worked in before clocking out, this adds
// that repo's part of tomorrow's list to the session context, so Claude knows where you left off.
// Each repo is picked up once. The hook removes itself when every repo is picked up or the notes
// are more than 4 days old. It does nothing while you are still clocked out.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.join(dir, "pickup.json");
const MAX_AGE_MS = 4 * 86400000;

if (process.env.CLOCKOUT_INTERNAL === "1") process.exit(0);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  // no input
}
if (input.source && input.source !== "startup") process.exit(0);

let state;
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  process.exit(0);
}

function removeSelf() {
  try {
    const settings = JSON.parse(fs.readFileSync(state.settingsPath, "utf8"));
    const list = settings.hooks?.SessionStart;
    if (!Array.isArray(list)) return;
    settings.hooks.SessionStart = list
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => h.command !== state.hookCommand) }))
      .filter((entry) => entry.hooks.length > 0);
    if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(state.settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // settings missing or unreadable
  }
}

if (Date.now() - Date.parse(state.createdAt) > MAX_AGE_MS) {
  removeSelf();
  process.exit(0);
}

// Not morning yet: keep the notes until the next working day starts.
if (state.notBefore && Date.now() < Date.parse(state.notBefore)) process.exit(0);

// Still clocked out: keep the notes for the morning.
try {
  const pause = JSON.parse(fs.readFileSync(path.join(dir, "pause.json"), "utf8"));
  if (Date.now() < Date.parse(pause.until)) process.exit(0);
} catch {
  // not paused
}

const cwd = input.cwd || process.cwd();
let realCwd = cwd;
try {
  realCwd = fs.realpathSync(cwd);
} catch {
  // keep cwd
}
const inside = (p) => [cwd, realCwd].some((c) => c === p || c.startsWith(p + path.sep));
const repo = state.repos.find((r) => !r.pickedUpAt && (inside(r.path) || inside(r.realPath)));
if (!repo) process.exit(0);

repo.pickedUpAt = new Date().toISOString();
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
if (state.repos.every((r) => r.pickedUpAt)) removeSelf();

const context = [
  `Clockout: notes the developer saved when they clocked out on ${state.date}, for the repo ${repo.repo}.`,
  "Use them to continue where they left off when their request relates to this work. Mention them briefly only if relevant.",
  "",
  repo.markdown,
].join("\n");
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
