#!/usr/bin/env node
// Clockout status line for Claude Code.
// Shows your hands-on time today and how long since your last break, from your own prompts in
// today's Claude Code logs (Claude's output doesn't count). Reads logs incrementally and keeps a
// small cache next to this script, so each refresh only parses what changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const BREAK_MS = 15 * 60000;
const MIN_BLOCK_MS = 5 * 60000;
const TYPED_TAGS = ["<command-name>", "<command-message>", "<bash-input>"];

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(dir, "statusline-config.json"), "utf8"));
} catch {
  // defaults below
}
const claudeDir = config.claudeDir || process.env.CLAUDE_DIR || path.join(os.homedir(), ".claude");
const cachePath = path.join(dir, "statusline-cache.json");

const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const hm = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${pad(m % 60)}m`;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function isHuman(line) {
  if (line.type !== "user" || line.isSidechain || line.isMeta) return false;
  const c = line.message?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return false;
    text = c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
    if (!text.trim() && c.some((b) => b?.type === "image")) return true;
  }
  text = text.trim();
  if (!text) return false;
  return !text.startsWith("<") || TYPED_TAGS.some((t) => text.startsWith(t));
}

// Paused by Clockout?
try {
  const pause = JSON.parse(fs.readFileSync(path.join(dir, "pause.json"), "utf8"));
  if (Date.now() < Date.parse(pause.until)) {
    process.stdout.write(`Clockout · clocked out until ${pause.untilLabel}\n`);
    process.exit(0);
  }
} catch {
  // not paused
}

let cache = { date: "", files: {}, minutes: [] };
try {
  cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
} catch {
  // first run
}
if (cache.date !== today()) cache = { date: today(), files: {}, minutes: [] };

const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
const minutes = new Set(cache.minutes);
const projects = path.join(claudeDir, "projects");
let entries = [];
try {
  entries = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory());
} catch {
  // no logs yet
}
for (const project of entries) {
  const pdir = path.join(projects, project.name);
  let files = [];
  try {
    files = fs.readdirSync(pdir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    continue;
  }
  for (const f of files) {
    const file = path.join(pdir, f);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < midnight.getTime()) continue;
    let offset = cache.files[file] ?? 0;
    if (stat.size < offset) offset = 0; // file was rewritten
    if (stat.size === offset) continue;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) continue; // wait for a complete line
    for (const raw of text.slice(0, end).split("\n")) {
      if (!raw.includes('"type":"user"')) continue;
      try {
        const line = JSON.parse(raw);
        const ts = Date.parse(line.timestamp);
        if (ts >= midnight.getTime() && !String(line.cwd ?? "").startsWith(dir) && isHuman(line)) {
          minutes.add(Math.floor(ts / 60000) * 60000);
        }
      } catch {
        // skip bad line
      }
    }
    cache.files[file] = offset + Buffer.byteLength(text.slice(0, end + 1));
  }
}
cache.minutes = [...minutes].sort((a, b) => a - b);
try {
  fs.writeFileSync(cachePath, JSON.stringify(cache));
} catch {
  // cache is optional
}

if (cache.minutes.length === 0) {
  process.stdout.write("Clockout · no prompts from you yet today\n");
  process.exit(0);
}

// Blocks of your own activity: a gap of 15 minutes or more is a break.
const blocks = [];
for (const t of cache.minutes) {
  const last = blocks[blocks.length - 1];
  if (last && t - last.end <= BREAK_MS) last.end = t;
  else blocks.push({ start: t, end: t });
}
const now = Date.now();
const total = blocks.reduce((a, b) => a + Math.max(b.end - b.start, MIN_BLOCK_MS), 0);
const current = blocks[blocks.length - 1];
const onBreak = now - current.end > BREAK_MS;
const tail = onBreak ? `on a break since ${clock(current.end)}` : `${hm(Math.max(now - current.start, 60000))} since your last break`;
process.stdout.write(`Clockout · ${hm(total)} hands-on today · ${tail}\n`);
