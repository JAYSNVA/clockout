import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Points every Clockout path (and HOME) at a fresh temp folder.
export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clockout-test-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  Object.assign(process.env, {
    HOME: home,
    CLOCKOUT_HOME: path.join(home, ".clockout"),
    CLAUDE_DIR: path.join(home, ".claude"),
    CLOCKOUT_TOMORROW_DIR: path.join(home, "clockout"),
    CLOCKOUT_SCAN_ROOTS: path.join(home, "code"),
    GIT_CONFIG_NOSYSTEM: "1",
    CLOCKOUT_SUMMARY: "off", // tests never call Claude; the summary test opts back in with a fake CLI
  });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLOCKOUT_CLAUDE_BIN;
  fs.mkdirSync(path.join(home, "code"), { recursive: true });
  return { root, home, code: path.join(home, "code"), claudeDir: path.join(home, ".claude") };
}

export function sh(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

export function author(name: string, email: string, date: Date) {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date.toISOString(),
    GIT_COMMITTER_DATE: date.toISOString(),
  };
}

export function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "dev@example.com"]);
  sh(dir, ["config", "user.name", "Dev"]);
  return dir;
}

export function commit(dir: string, file: string, content: string, message: string, env: Record<string, string>) {
  fs.writeFileSync(path.join(dir, file), content);
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", message], env);
}

export function todayAt(h: number, m = 0) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

// Writes a Claude Code session log with one entry per minute between start and end: a prompt from
// the developer at the start (and every `promptEvery` minutes), Claude's replies in between.
export function writeClaudeSession(
  claudeDir: string,
  opts: { sessionId: string; cwd: string; start: Date; end: Date; gitBranch?: string; prompt?: string; promptEvery?: number },
) {
  const dir = path.join(claudeDir, "projects", opts.cwd.replace(/[/.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const base = { sessionId: opts.sessionId, cwd: opts.cwd, gitBranch: opts.gitBranch ?? "main", isSidechain: false };
  lines.push(JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: opts.sessionId }));
  lines.push(JSON.stringify({ ...base, type: "user", timestamp: opts.start.toISOString(), message: { role: "user", content: opts.prompt ?? "hello" } }));
  for (let t = opts.start.getTime() + 60000, i = 1; t <= opts.end.getTime(); t += 60000, i++) {
    const timestamp = new Date(t).toISOString();
    if (opts.promptEvery && i % opts.promptEvery === 0) {
      lines.push(JSON.stringify({ ...base, type: "user", timestamp, message: { role: "user", content: opts.prompt ?? "continue" } }));
    } else {
      lines.push(JSON.stringify({ ...base, type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${opts.sessionId}.jsonl`), lines.join("\n") + "\n");
}
