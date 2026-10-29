import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { SavedRepo } from "../shared/types.js";
import { paths } from "../shared/paths.js";
import type { LocalDetails } from "./collect.js";
import { dirtyFiles, repoName, repoToplevel } from "./git.js";

export interface RepoDay {
  repo: string;
  tasks: string[];
  commits: string[];
  saved?: SavedRepo;
  uncommitted: string[];
  lastPrompts: { task: string | null; text: string }[]; // last request to Claude per task
}

export type SummarySource = "api" | "claude-code";

export interface Notes {
  notes: Record<string, string>; // repo -> "where you left off"
  source: SummarySource;
}

function sameLocalDay(iso: string, day: Date) {
  const d = new Date(iso);
  return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
}

// What the developer did today, per repo, from local data only.
export function todayByRepo(local: LocalDetails, saved: SavedRepo[], now: Date): RepoDay[] {
  const repos = new Map<string, RepoDay>();
  const get = (repo: string) => {
    if (!repos.has(repo)) repos.set(repo, { repo, tasks: [], commits: [], uncommitted: [], lastPrompts: [] });
    return repos.get(repo)!;
  };

  for (const c of local.commits) {
    if (!sameLocalDay(c.ts, now) || !local.localEmails.includes(c.email)) continue;
    const r = get(c.repo);
    r.commits.push(c.subject);
    if (c.task && !r.tasks.includes(c.task)) r.tasks.push(c.task);
  }
  for (const pr of local.prompts) {
    if (!sameLocalDay(pr.ts, now)) continue;
    const top = repoToplevel(pr.cwd);
    const r = get(top ? repoName(top) : pr.cwd.split("/").pop() || "unknown");
    r.lastPrompts = r.lastPrompts.filter((p) => p.task !== pr.task).concat({ task: pr.task, text: pr.text });
    if (pr.task && !r.tasks.includes(pr.task)) r.tasks.push(pr.task);
  }
  for (const s of saved) {
    if (s.status === "saved") get(s.repo).saved = s;
  }
  for (const r of repos.values()) {
    const top = local.repoPaths.get(r.repo);
    if (top) r.uncommitted = dirtyFiles(top);
  }
  return [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

function clip(text: string, max: number) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// One repo's part of tomorrow's list. Also used as the morning pickup note for that repo.
export function repoSection(d: RepoDay, note?: string): string {
  const lines = [`## ${d.repo}${d.tasks.length ? ` — ${d.tasks.join(", ")}` : ""}`, ""];
  if (note) lines.push(`- **Where you left off:** ${clip(note, 400)}`);
  for (const p of d.lastPrompts) {
    lines.push(`- **Last thing you asked Claude${p.task ? ` on ${p.task}` : ""}:** "${clip(p.text, 240)}"`);
  }
  if (d.commits.length) {
    lines.push(`- **Commits today (${d.commits.length}):**`);
    for (const c of d.commits.slice(0, 5)) lines.push(`  - ${clip(c, 120)}`);
  }
  if (d.saved) {
    const files = `${d.saved.files} ${d.saved.files === 1 ? "file" : "files"}`;
    lines.push(`- **Open work saved** on branch \`${d.saved.branch}\` (${files}). Restore with \`git checkout ${d.saved.branch} -- .\``);
  }
  if (d.uncommitted.length) {
    const shown = d.uncommitted.slice(0, 8).map((f) => `\`${f}\``).join(", ");
    lines.push(`- **Uncommitted files (${d.uncommitted.length}):** ${shown}${d.uncommitted.length > 8 ? " …" : ""}`);
  }
  return lines.join("\n");
}

export function tomorrowMarkdown(days: RepoDay[], date: string, pauseLabel: string | null, notes: Record<string, string> = {}): string {
  const lines = [`# Tomorrow — picked up from ${date}`, "", pauseLabel ? `Agents paused until ${pauseLabel}.` : "Agents were not paused.", ""];
  if (days.length === 0) {
    lines.push("No Claude Code or git activity found today. Nothing to pick up.");
    return lines.join("\n") + "\n";
  }
  for (const d of days) lines.push(repoSection(d, notes[d.repo]), "");
  return lines.join("\n");
}

function summaryPrompt(days: RepoDay[]) {
  const facts = days
    .map((d) =>
      [
        `Repo: ${d.repo}`,
        d.tasks.length ? `Tasks: ${d.tasks.join(", ")}` : "",
        ...d.lastPrompts.map((p) => `Last request to Claude${p.task ? ` on ${p.task}` : ""}: ${clip(p.text, 500)}`),
        d.commits.length ? `Commits today: ${d.commits.slice(0, 10).map((c) => clip(c, 120)).join(" | ")}` : "",
        d.uncommitted.length ? `Uncommitted files: ${d.uncommitted.slice(0, 15).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return (
    "A developer is clocking out. Below is what they did today in each repo. For each repo, write one or two short " +
    "sentences they will read first thing tomorrow: what they were in the middle of and the most likely next step. " +
    "Use only these facts. Reply with only a JSON object that maps each repo name to its note, " +
    'for example {"api": "You were adding retries to the webhook client; next, run the integration tests."}.\n\n' +
    facts
  );
}

// Pulls the JSON object out of a model reply and keeps only notes for known repos.
export function parseNotes(text: string, repos: string[]): Record<string, string> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const notes: Record<string, string> = {};
    for (const repo of repos) {
      const v = obj[repo];
      if (typeof v === "string" && v.trim()) notes[repo] = v.trim();
    }
    return Object.keys(notes).length ? notes : undefined;
  } catch {
    return undefined;
  }
}

async function viaApi(prompt: string): Promise<string | undefined> {
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  const response = await client.beta.messages.create({
    model: process.env.CLOCKOUT_MODEL || "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") return undefined;
  return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

export function findClaudeCli(): string | undefined {
  if (process.env.CLOCKOUT_CLAUDE_BIN) return fs.existsSync(process.env.CLOCKOUT_CLAUDE_BIN) ? process.env.CLOCKOUT_CLAUDE_BIN : undefined;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local")];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

// Runs Claude Code headless with the developer's existing login: no tools, no hooks,
// nothing saved to their session history. Runs in Clockout's own folder, which the collector ignores.
function viaClaudeCode(bin: string, prompt: string): Promise<string | undefined> {
  const cwd = paths().summaryDir;
  fs.mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CLOCKOUT_INTERNAL: "1" };
  delete env.CLAUDECODE; // allow running when Clockout itself was started from inside Claude Code
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--disable-slash-commands",
    ...(process.env.CLOCKOUT_MODEL ? ["--model", process.env.CLOCKOUT_MODEL] : []),
  ];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(undefined);
      try {
        const envelope = JSON.parse(out) as { is_error?: boolean; result?: string };
        resolve(envelope.is_error ? undefined : envelope.result);
      } catch {
        resolve(undefined);
      }
    });
  });
}

// Optional Claude-written "where you left off" notes, one per repo. Uses ANTHROPIC_API_KEY when set,
// otherwise the developer's Claude Code CLI. Returns undefined on any failure so the list built
// from data alone is always produced.
export async function claudeNotes(days: RepoDay[]): Promise<Notes | undefined> {
  if (days.length === 0 || process.env.CLOCKOUT_SUMMARY === "off") return undefined;
  const prompt = summaryPrompt(days);
  const repos = days.map((d) => d.repo);
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const notes = parseNotes((await viaApi(prompt)) ?? "", repos);
      return notes && { notes, source: "api" };
    }
    const bin = findClaudeCli();
    if (!bin) return undefined;
    const notes = parseNotes((await viaClaudeCode(bin, prompt)) ?? "", repos);
    return notes && { notes, source: "claude-code" };
  } catch {
    return undefined;
  }
}
