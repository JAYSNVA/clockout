import fs from "node:fs";
import { paths } from "../shared/paths.js";
import { addHook, hookCommand, installHookScript, removeHook, settingsPath } from "./hooks.js";

// Next workday at `resumeHour`. Clocking out before 05:00 resumes the same morning.
export function resumeTime(now: Date, resumeHour: number): Date {
  const d = new Date(now);
  d.setHours(resumeHour, 0, 0, 0);
  if (now.getHours() >= 5 || now >= d) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

export function timeLabel(d: Date) {
  const day = d.toLocaleDateString("en-GB", { weekday: "long" });
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Installs a PreToolUse hook that blocks Claude Code tool calls until `until`.
export function installPause(until: Date): { until: string; untilLabel: string } {
  const p = paths();
  installHookScript("pause-hook.mjs", p.pauseHook);
  const command = hookCommand(p.pauseHook);
  const state = { until: until.toISOString(), untilLabel: timeLabel(until), settingsPath: settingsPath(), hookCommand: command };
  fs.writeFileSync(p.pauseState, JSON.stringify(state, null, 2));
  addHook("PreToolUse", "*", command);
  return { until: state.until, untilLabel: state.untilLabel };
}

// Removes the pause hook and state. Returns true if a pause was active.
export function removePause(): boolean {
  const p = paths();
  const wasPaused = pauseStatus().paused;
  fs.rmSync(p.pauseState, { force: true });
  removeHook("PreToolUse", hookCommand(p.pauseHook));
  return wasPaused;
}

export function pauseStatus(): { paused: boolean; until?: string; untilLabel?: string } {
  const p = paths();
  if (!fs.existsSync(p.pauseState)) return { paused: false };
  try {
    const state = JSON.parse(fs.readFileSync(p.pauseState, "utf8"));
    if (Date.now() >= Date.parse(state.until)) return { paused: false };
    return { paused: true, until: state.until, untilLabel: state.untilLabel };
  } catch {
    return { paused: false };
  }
}
