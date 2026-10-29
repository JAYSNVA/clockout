import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommitEvent, SavedRepo, TaskDone } from "../shared/types.js";
import { firstJiraKey, jiraKeys } from "../shared/jira.js";

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

const toplevelCache = new Map<string, string | null>();

export function repoToplevel(dir: string): string | null {
  if (!dir) return null;
  if (toplevelCache.has(dir)) return toplevelCache.get(dir)!;
  const top = fs.existsSync(dir) ? tryGit(dir, ["rev-parse", "--show-toplevel"]) : null;
  toplevelCache.set(dir, top);
  return top;
}

const SKIP_DIRS = new Set(["node_modules", "Library", "Applications", "Movies", "Music", "Pictures", "Public", "target", "build", "dist"]);
const SKIP_PATTERN = /Google Drive|OneDrive|Dropbox|iCloud/i;

// Finds git repos under the given roots, up to `depth` folders deep. Does not descend into repos.
export function findRepos(roots: string[], depth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    if (fs.existsSync(path.join(dir, ".git"))) {
      found.push(dir);
      return;
    }
    if (level >= depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name) || SKIP_PATTERN.test(e.name)) continue;
      walk(path.join(dir, e.name), level + 1);
    }
  };
  for (const root of roots) if (fs.existsSync(root)) walk(root, 0);
  return found;
}

export function repoName(top: string): string {
  return path.basename(top);
}

// Display names for repos: the folder name, or "name (parent)" when two clones share a folder name.
export function repoNames(tops: string[]): Map<string, string> {
  const byBase = new Map<string, string[]>();
  for (const top of new Set(tops)) byBase.set(repoName(top), [...(byBase.get(repoName(top)) ?? []), top]);
  const names = new Map<string, string>();
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      names.set(group[0], base);
      continue;
    }
    const withParent = group.map((top) => `${base} (${path.basename(path.dirname(top))})`);
    const unique = new Set(withParent).size === group.length;
    group.forEach((top, i) => names.set(top, unique ? withParent[i] : `${base} (${top})`));
  }
  return names;
}

export function defaultBranch(top: string): string | null {
  const remoteHead = tryGit(top, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  for (const name of ["main", "master", "develop"]) {
    if (tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  return tryGit(top, ["symbolic-ref", "--short", "HEAD"]);
}

const SEP = "\x1f";

export interface RepoCommit extends CommitEvent {
  subject: string;
}

// All authors' commits since `since`, excluding Clockout's own WIP branches.
export function readCommits(top: string, since: Date, repo = repoName(top)): RepoCommit[] {
  const out = tryGit(top, [
    "log",
    "--exclude=clockout/*",
    "--branches",
    "--remotes",
    "--source",
    `--since=${since.toISOString()}`,
    `--format=%H${SEP}%aI${SEP}%ae${SEP}%an${SEP}%S${SEP}%s`,
  ]);
  if (!out) return [];
  const def = defaultBranch(top);
  const onDefault = new Set(
    def ? (tryGit(top, ["rev-list", `--since=${since.toISOString()}`, def]) ?? "").split("\n").filter(Boolean) : [],
  );
  // Commits that arrived on the default branch through a merge take the merge's Jira key
  // ("Merge branch 'feature/PAY-7-login'").
  const mergedKey = new Map<string, string>();
  if (def) {
    const merges = tryGit(top, ["log", "--first-parent", "--merges", `--since=${since.toISOString()}`, def, `--format=%H${SEP}%s`]) ?? "";
    for (const line of merges.split("\n")) {
      const [merge, subject] = line.split(SEP);
      const key = firstJiraKey(subject);
      if (!merge || !key) continue;
      for (const sha of (tryGit(top, ["rev-list", `${merge}^1..${merge}^2`]) ?? "").split("\n")) {
        if (sha && !mergedKey.has(sha)) mergedKey.set(sha, key);
      }
    }
  }
  const commits: RepoCommit[] = [];
  for (const line of out.split("\n")) {
    const [sha, ts, email, name, source, subject] = line.split(SEP);
    if (!sha || !ts) continue;
    commits.push({
      sha,
      ts: new Date(ts).toISOString(),
      email: (email ?? "").toLowerCase(),
      name: name ?? "",
      repo,
      // The branch name only counts for commits that are not on the default branch yet:
      // --source reports any ref that reaches the commit.
      task: firstJiraKey(subject) ?? (onDefault.has(sha) ? mergedKey.get(sha) ?? null : firstJiraKey(source)),
      onDefault: onDefault.has(sha),
      subject: subject ?? "",
    });
  }
  return commits;
}

// Task "done" dates inferred from git: a commit on the default branch mentioning the key
// (merge commits and squash merges), or a branch named after the key that is merged.
export function readTaskDone(top: string, since: Date, repo = repoName(top)): TaskDone[] {
  const def = defaultBranch(top);
  if (!def) return [];
  const done = new Map<string, string>();
  const log = tryGit(top, ["log", "--first-parent", def, `--since=${since.toISOString()}`, `--format=%cI${SEP}%s`]) ?? "";
  for (const line of log.split("\n")) {
    const [ts, subject] = line.split(SEP);
    if (!ts) continue;
    for (const key of jiraKeys(subject)) {
      const iso = new Date(ts).toISOString();
      if (!done.has(key) || done.get(key)! > iso) done.set(key, iso);
    }
  }
  // A merged branch whose tip is on the default branch's first-parent line had no commits
  // of its own (just created, or fast-forwarded), so it does not mark its task done.
  const mainLine = new Set((tryGit(top, ["rev-list", "--first-parent", def]) ?? "").split("\n"));
  const merged = tryGit(top, ["branch", "--merged", def, "--format=%(refname:short)%09%(objectname)"]) ?? "";
  for (const line of merged.split("\n")) {
    const [branch, sha] = line.split("\t");
    if (!branch || branch === def || branch.startsWith("clockout/") || mainLine.has(sha)) continue;
    const key = firstJiraKey(branch);
    if (!key || done.has(key)) continue;
    const tip = tryGit(top, ["log", "-1", "--format=%cI", branch]);
    if (tip) done.set(key, new Date(tip).toISOString());
  }
  return [...done].map(([key, doneAt]) => ({ key, repo, doneAt }));
}

export function dirtyFiles(top: string): string[] {
  const out = tryGit(top, ["status", "--porcelain"]) ?? "";
  return out.split("\n").filter(Boolean).map((l) => l.slice(3));
}

export function currentBranch(top: string): string | null {
  return tryGit(top, ["symbolic-ref", "--short", "HEAD"]);
}

function inProgressOperation(top: string): string | null {
  for (const [marker, label] of [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
  ]) {
    const p = tryGit(top, ["rev-parse", "--git-path", marker]);
    if (p && fs.existsSync(path.resolve(top, p))) return label;
  }
  return null;
}

// Saves uncommitted work (tracked and untracked, respecting .gitignore) as a commit on
// `clockout/<date>` using a temporary index. The working tree, the real index and the
// current branch are never touched. Nothing is pushed.
export function saveOpenWork(top: string, date: string, now = new Date(), repo = repoName(top)): SavedRepo {
  const files = dirtyFiles(top);
  if (files.length === 0) return { repo, path: top, status: "skipped", reason: "no uncommitted changes" };
  const op = inProgressOperation(top);
  if (op) return { repo, path: top, status: "skipped", reason: `${op} in progress` };
  const head = tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head) return { repo, path: top, status: "skipped", reason: "no commits yet" };

  const tmpIndex = path.join(os.tmpdir(), `clockout-index-${process.pid}-${Date.now()}`);
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: tryGit(top, ["config", "user.name"]) || "Clockout",
    GIT_AUTHOR_EMAIL: tryGit(top, ["config", "user.email"]) || "clockout@localhost",
  };
  env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  try {
    git(top, ["read-tree", "HEAD"], env);
    git(top, ["add", "-A"], env);
    const tree = git(top, ["write-tree"], env);
    const from = currentBranch(top) ?? "detached HEAD";
    const message = `WIP: clockout ${date}\n\nSaved by Clockout from ${from} (${files.length} files). Not pushed.`;
    const commit = git(top, ["commit-tree", tree, "-p", head, "-m", message], env);
    let branch = `clockout/${date}`;
    if (tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
      const hhmm = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      branch = `${branch}-${hhmm}`;
      let n = 2;
      while (tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) branch = `clockout/${date}-${hhmm}-${n++}`;
    }
    git(top, ["update-ref", `refs/heads/${branch}`, commit]);
    return { repo, path: top, status: "saved", branch, files: files.length };
  } catch (err) {
    return { repo, path: top, status: "skipped", reason: `git error: ${(err as Error).message.split("\n")[0]}` };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

// Deletes Clockout's own WIP branches (clockout/<date>, made by saveOpenWork) older than `keepDays`.
// Branches with commits that Clockout didn't make, and the checked-out branch, are never touched.
export function pruneClockoutBranches(top: string, keepDays: number, now = new Date()): string[] {
  const out = tryGit(top, ["for-each-ref", `--format=%(refname:short)${SEP}%(committerdate:unix)${SEP}%(subject)`, "refs/heads/clockout/"]) ?? "";
  const current = currentBranch(top);
  const cutoff = now.getTime() / 1000 - keepDays * 86400;
  const deleted: string[] = [];
  for (const line of out.split("\n")) {
    const [branch, when, subject] = line.split(SEP);
    if (!branch || branch === current || !subject?.startsWith("WIP: clockout") || Number(when) >= cutoff) continue;
    if (tryGit(top, ["update-ref", "-d", `refs/heads/${branch}`]) !== null) deleted.push(branch);
  }
  return deleted;
}
