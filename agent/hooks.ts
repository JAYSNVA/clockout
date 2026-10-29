// Adds and removes Clockout's own entries in Claude Code's user settings (~/.claude/settings.json).
// Other settings and hooks are never changed; a backup is written before every edit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../shared/paths.js";

interface HookEntry {
  matcher?: string;
  hooks?: { type: string; command?: string }[];
}

export const HOOK_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function settingsPath() {
  return path.join(paths().claudeDir, "settings.json");
}

function readSettings(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeSettings(file: string, settings: Record<string, any>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

// Copies a hook script into ~/.clockout so it keeps working if this repo moves.
export function installHookScript(name: string, target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(HOOK_SOURCE_DIR, name), target);
}

export function hookCommand(script: string) {
  return `node "${script}"`;
}

export function addHook(event: string, matcher: string, command: string) {
  const file = settingsPath();
  const settings = readSettings(file);
  const list: HookEntry[] = settings.hooks?.[event] ?? [];
  if (list.some((e) => e.hooks?.some((h) => h.command === command))) return;
  if (fs.existsSync(file)) {
    fs.mkdirSync(paths().backups, { recursive: true });
    fs.copyFileSync(file, path.join(paths().backups, `settings-${Date.now()}.json`));
  }
  settings.hooks ??= {};
  settings.hooks[event] = [...list, { matcher, hooks: [{ type: "command", command }] }];
  writeSettings(file, settings);
}

// Returns true if the hook was installed.
export function removeHook(event: string, command: string): boolean {
  const file = settingsPath();
  if (!fs.existsSync(file)) return false;
  const settings = readSettings(file);
  const list: HookEntry[] | undefined = settings.hooks?.[event];
  if (!Array.isArray(list) || !list.some((e) => e.hooks?.some((h) => h.command === command))) return false;
  const next = list
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => h.command !== command) }))
    .filter((e) => e.hooks.length > 0);
  if (next.length) settings.hooks[event] = next;
  else delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(file, settings);
  return true;
}
