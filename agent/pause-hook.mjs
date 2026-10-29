#!/usr/bin/env node
// Clockout pause hook for Claude Code (PreToolUse).
// Blocks every tool call until the resume time in pause.json, then removes itself.
// Each blocked call is logged (time and tool name only) so Clockout can show the evenings it protected.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.join(dir, "pause.json");

// Clockout's own background calls (the tomorrow's-list summary) are never blocked.
if (process.env.CLOCKOUT_INTERNAL === "1") process.exit(0);

function removeSelf(settingsPath, hookCommand) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const list = settings.hooks?.PreToolUse;
    if (!Array.isArray(list)) return;
    settings.hooks.PreToolUse = list
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => h.command !== hookCommand) }))
      .filter((entry) => entry.hooks.length > 0);
    if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // settings missing or unreadable: nothing to remove
  }
}

let state = null;
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  process.exit(0);
}

if (Date.now() < Date.parse(state.until)) {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    // no or invalid input: still block
  }
  try {
    fs.appendFileSync(path.join(dir, "blocked.log"), JSON.stringify({ ts: new Date().toISOString(), tool: input.tool_name ?? null }) + "\n");
  } catch {
    // logging must never stop the block
  }
  process.stderr.write(
    `Clocked out until ${state.untilLabel}. Run \`npm run resume\` in the Clockout folder or press Resume in Clockout to override.\n`,
  );
  process.exit(2);
}

removeSelf(state.settingsPath, state.hookCommand);
fs.rmSync(statePath, { force: true });
process.exit(0);
