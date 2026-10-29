import fs from "node:fs";
import { paths } from "../shared/paths.js";
import { addHook, hookCommand, installHookScript, removeHook, settingsPath } from "./hooks.js";

export interface PickupRepo {
  repo: string;
  path: string;
  realPath: string;
  markdown: string;
  pickedUpAt?: string;
}

export interface PickupState {
  date: string;
  createdAt: string;
  settingsPath: string;
  hookCommand: string;
  repos: PickupRepo[];
}

// Saves per-repo notes and installs the SessionStart hook that hands them to the next session.
export function installPickup(date: string, repos: { repo: string; path: string; markdown: string }[], now = new Date()) {
  const p = paths();
  const command = hookCommand(p.pickupHook);
  if (repos.length === 0) {
    removePickup();
    return;
  }
  installHookScript("pickup-hook.mjs", p.pickupHook);
  const state: PickupState = {
    date,
    createdAt: now.toISOString(),
    settingsPath: settingsPath(),
    hookCommand: command,
    repos: repos.map((r) => ({ ...r, realPath: safeRealpath(r.path) })),
  };
  fs.writeFileSync(p.pickupState, JSON.stringify(state, null, 2));
  addHook("SessionStart", "startup", command);
}

export function removePickup() {
  const p = paths();
  fs.rmSync(p.pickupState, { force: true });
  removeHook("SessionStart", hookCommand(p.pickupHook));
}

export function pickupStatus(): { date: string; repos: { repo: string; pickedUpAt: string | null }[] } | null {
  try {
    const state = JSON.parse(fs.readFileSync(paths().pickupState, "utf8")) as PickupState;
    return { date: state.date, repos: state.repos.map((r) => ({ repo: r.repo, pickedUpAt: r.pickedUpAt ?? null })) };
  } catch {
    return null;
  }
}

function safeRealpath(p: string) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
