// `npm run demo`: runs Clockout on a generated sample team instead of your real data.
//
// Everything lives in ./.demo and is rebuilt on every run, with dates relative to today:
//   - three real git repos with six weeks of history (task branches, merges, open work),
//   - Claude Code session logs for the developer on "this machine" (Aoife),
//   - agent data for four teammates, sent the same way a remote agent sends it,
//   - a week of past clock-outs and paused agent calls.
// The app then reads it through the normal collector and server. Your real ~/.claude folder,
// repos and Clockout database are never touched, so Clock out is safe to try here.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeEvent, ClockoutResult, CollectPayload } from "../shared/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(root, ".demo");
const code = path.join(demo, "code");

fs.rmSync(demo, { recursive: true, force: true });
fs.mkdirSync(code, { recursive: true });
fs.writeFileSync(path.join(demo, "gitconfig"), "[user]\n\tname = Aoife\n\temail = aoife@acme.dev\n");
Object.assign(process.env, {
  CLOCKOUT_DEMO: "1",
  CLOCKOUT_HOME: path.join(demo, "clockout-home"),
  CLAUDE_DIR: path.join(demo, "claude"),
  CLOCKOUT_SCAN_ROOTS: code,
  CLOCKOUT_TOMORROW_DIR: path.join(demo, "tomorrow"),
  GIT_CONFIG_GLOBAL: path.join(demo, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  CLOCKOUT_SUMMARY: process.env.CLOCKOUT_SUMMARY ?? "off", // no Claude calls unless you opt in
  PORT: process.env.PORT ?? "4322",
});

// Imported after the environment points at .demo.
const { openDb } = await import("../server/db.js");
const { createDeveloper, ensureLocalDevice, ingestPayload, linkLocalDevice, recomputeAll, signIn } = await import("../server/store.js");
const { run } = await import("../server/db.js");
const { collect } = await import("../agent/collect.js");
const { installPickup } = await import("../agent/pickup.js");
const { repoSection, tomorrowMarkdown } = await import("../agent/tomorrow.js");
const { resumeTime, timeLabel } = await import("../agent/pause.js");
const { paths } = await import("../shared/paths.js");

// ---------- deterministic randomness ----------
let seed = 20261029;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number) => a + rand() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const MIN = 60000;
const DAYS = 42;
const now = new Date();
const dayStart = (daysAgo: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
};
const at = (daysAgo: number, hours: number) => dayStart(daysAgo) + Math.round(hours * 60) * MIN;
const dateKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isWeekend = (daysAgo: number) => [0, 6].includes(new Date(dayStart(daysAgo)).getDay());

// ---------- the team and their work ----------
const REPOS: Record<string, { prefix: string; next: number; tasks: [string, string][] }> = {
  payments: {
    prefix: "PAY",
    next: 101,
    tasks: [
      ["refund-idempotency", "Add idempotency keys to refunds"], ["webhook-retries", "Retry failed webhooks with backoff"],
      ["currency-rounding", "Fix currency rounding in invoices"], ["invoice-pdf", "Generate invoice PDFs"],
      ["sca-flow", "Strong customer authentication flow"], ["payout-report", "Weekly payout report"],
      ["fraud-rules", "Configurable fraud rules"], ["ledger-reconcile", "Nightly ledger reconciliation"],
      ["dispute-flow", "Card dispute workflow"], ["tax-rates", "Tax rates per region"], ["saved-cards", "Saved cards for returning customers"],
    ],
  },
  "web-app": {
    prefix: "WEB",
    next: 201,
    tasks: [
      ["checkout-redesign", "Redesign the checkout page"], ["navbar-mobile", "Fix the navbar on mobile"],
      ["dark-mode", "Dark mode"], ["onboarding-tour", "Onboarding tour for new users"], ["a11y-forms", "Accessible form errors"],
      ["search-filters", "Search filters"], ["settings-page", "New settings page"], ["error-boundaries", "Error boundaries and fallbacks"],
      ["order-history", "Order history page"], ["empty-states", "Empty states"],
    ],
  },
  "platform-api": {
    prefix: "API",
    next: 301,
    tasks: [
      ["rate-limiting", "Per-tenant rate limiting"], ["pagination", "Cursor pagination"], ["audit-log", "Audit log endpoint"],
      ["oauth-scopes", "OAuth scopes"], ["bulk-import", "Bulk import API"], ["health-checks", "Deep health checks"],
      ["cache-layer", "Redis cache layer"], ["openapi-docs", "OpenAPI docs"], ["tenant-export", "Tenant data export"],
      ["webhook-signing", "Sign outgoing webhooks"], ["slow-queries", "Fix slow tenant queries"],
    ],
  },
};

interface Task {
  key: string;
  branch: string;
  title: string;
  repo: string;
}

function newTask(repo: string): Task {
  const r = REPOS[repo];
  const [slug, title] = r.tasks.shift() ?? [`task-${r.next}`, `Task ${r.next}`];
  const key = `${r.prefix}-${r.next++}`;
  return { key, branch: `${key}-${slug}`, title, repo };
}

interface Profile {
  name: string;
  email: string;
  local?: boolean; // the developer on this machine: real Claude Code log files
  gitOnly?: boolean; // no Claude Code, commits only
  start: number;
  end: number;
  lateProb: number;
  parallelProb: number;
  promptGap: [number, number];
  soloProb: number;
  taskDays: [number, number];
  repos: string[];
  weekendProb?: number;
  joinedDaysAgo?: number;
  stalled?: { daysAgo: number; length: number }; // a task started and then left unmerged
  clockoutSinceDaysAgo?: number; // started clocking out this many days ago
}

const TEAM: Profile[] = [
  { name: "Aoife", email: "aoife@acme.dev", local: true, start: 9, end: 17.9, lateProb: 0.6, parallelProb: 0.6, promptGap: [3, 9], soloProb: 0.35, taskDays: [2, 4], repos: ["payments", "web-app"], clockoutSinceDaysAgo: 7 },
  { name: "Ben", email: "ben@acme.dev", start: 8.4, end: 19.6, lateProb: 0.65, parallelProb: 0.9, promptGap: [2, 6], soloProb: 0.5, taskDays: [6, 9], repos: ["platform-api", "payments"], weekendProb: 0.35, stalled: { daysAgo: 11, length: 3 } },
  { name: "Chen", email: "chen@acme.dev", start: 9.5, end: 17.4, lateProb: 0.04, parallelProb: 0.3, promptGap: [4, 12], soloProb: 0.2, taskDays: [1, 3], repos: ["web-app", "platform-api"] },
  { name: "Dara", email: "dara@acme.dev", gitOnly: true, start: 10, end: 18, lateProb: 0, parallelProb: 0, promptGap: [10, 30], soloProb: 0, taskDays: [3, 5], repos: ["platform-api"] },
  { name: "Emeka", email: "emeka@acme.dev", start: 9, end: 18.2, lateProb: 0.3, parallelProb: 0.45, promptGap: [3, 10], soloProb: 0.3, taskDays: [3, 5], repos: ["payments", "web-app"], joinedDaysAgo: 20, stalled: { daysAgo: 6, length: 2 } },
];

const FOLLOW_UPS = [
  "run the tests and fix what fails", "add unit tests for the edge cases", "refactor this into a helper",
  "why is this test flaky?", "update the docs for this change", "check the error handling here",
  "review the diff before I commit", "handle the empty case", "make the naming consistent",
];
const COMMIT_STEPS = ["scaffold", "core logic", "tests", "review fixes", "edge cases", "cleanup", "docs"];

interface Minute {
  ts: number;
  sessionId: string;
  repo: string;
  task: Task;
  human: boolean;
  agent: boolean;
  prompt?: string;
}
interface GitOp {
  ts: number;
  repo: string;
  dev: Profile;
  task: Task;
  type: "commit" | "merge";
  message: string;
}

const minutes = new Map<string, Minute[]>(); // dev -> minute events
const gitOps: GitOp[] = [];
const lastBlockEnd = new Map<string, number>(); // `${dev}:${daysAgo}` -> end of the day's work
const openTasks = new Map<string, Task>(); // dev -> task in progress now

function addMinute(list: Minute[], m: Minute) {
  if (m.ts >= now.getTime()) return;
  list.push(m);
}

// One Claude Code session: the developer prompts, Claude works, repeat until the block ends.
function session(dev: Profile, list: Minute[], task: Task, from: number, to: number, gap: [number, number], firstPrompt: boolean) {
  const sessionId = uuid();
  let t = from;
  let first = firstPrompt;
  let lastHuman = t;
  while (t <= to) {
    const prompt = first ? `${task.key}: ${task.title.toLowerCase()}` : pick(FOLLOW_UPS);
    first = false;
    addMinute(list, { ts: t, sessionId, repo: task.repo, task, human: true, agent: false, prompt });
    lastHuman = t;
    const work = int(2, Math.max(3, gap[1] - 1));
    for (let k = 1; k <= work; k++) addMinute(list, { ts: t + k * MIN, sessionId, repo: task.repo, task, human: false, agent: true });
    t += (work + int(1, Math.max(1, gap[1] - work))) * MIN;
  }
  if (chance(dev.soloProb)) {
    const solo = int(20, 60);
    for (let k = 1; k <= solo; k++) addMinute(list, { ts: lastHuman + k * MIN, sessionId, repo: task.repo, task, human: false, agent: true });
  }
  return lastHuman;
}

function commitDuring(dev: Profile, task: Task, from: number, to: number, count: number) {
  for (let i = 0; i < count; i++) {
    const ts = Math.round(between(from, to) / MIN) * MIN;
    if (ts < now.getTime()) gitOps.push({ ts, repo: task.repo, dev, task, type: "commit", message: `${task.key} ${task.title.toLowerCase()}: ${pick(COMMIT_STEPS)}` });
  }
}

for (const dev of TEAM) {
  const list: Minute[] = [];
  minutes.set(dev.name, list);
  let task = newTask(pick(dev.repos));
  let daysLeft = int(...dev.taskDays);
  const stalledTask = dev.stalled ? newTask(pick(dev.repos)) : undefined;

  for (let d = Math.min(DAYS, dev.joinedDaysAgo ?? DAYS); d >= 0; d--) {
    const weekend = isWeekend(d);
    if (weekend && !chance(dev.weekendProb ?? 0)) continue;
    const clockingOut = dev.clockoutSinceDaysAgo !== undefined && d <= dev.clockoutSinceDaysAgo;
    const late = !weekend && !clockingOut && chance(dev.lateProb);
    const end = clockingOut ? between(17.6, 18.2) : dev.end + between(-0.4, 0.5);
    const blocks: [number, number][] = weekend
      ? [[at(d, between(11, 13)), at(d, between(14, 16))]]
      : [
          [at(d, dev.start + between(-0.2, 0.3)), at(d, between(12, 12.6))],
          [at(d, between(13.2, 13.7)), at(d, end)],
          ...(late ? [[at(d, between(20.3, 21)), at(d, between(22, 23.6))] as [number, number]] : []),
        ];
    const stalledToday = stalledTask && dev.stalled && d <= dev.stalled.daysAgo && d > dev.stalled.daysAgo - dev.stalled.length;
    let dayEnd = 0;

    for (const [from, to] of blocks) {
      if (from >= now.getTime()) continue;
      if (dev.gitOnly) {
        commitDuring(dev, task, from, to, int(0, 2));
        dayEnd = Math.max(dayEnd, Math.min(to, now.getTime()));
        continue;
      }
      dayEnd = Math.max(dayEnd, session(dev, list, task, from, to, dev.promptGap, from === blocks[0][0]));
      const second = stalledToday ? stalledTask : chance(dev.parallelProb) ? task : undefined;
      if (second) {
        const pFrom = from + int(10, 40) * MIN;
        const pTo = to - int(0, 30) * MIN;
        if (pTo > pFrom) session(dev, list, second, pFrom, pTo, [dev.promptGap[0] + 5, dev.promptGap[1] + 9], second === stalledTask);
        if (second === stalledTask) commitDuring(dev, stalledTask, pFrom, pTo, 1);
      }
      commitDuring(dev, task, from, Math.min(to, now.getTime()), int(0, 2));
    }
    lastBlockEnd.set(`${dev.name}:${d}`, dayEnd);

    daysLeft--;
    if (daysLeft <= 0 && d > 0 && dayEnd > 0) {
      // Every merged task has at least one commit of its own.
      gitOps.push({ ts: dayEnd - int(5, 20) * MIN, repo: task.repo, dev, task, type: "commit", message: `${task.key} ${task.title.toLowerCase()}: final touches` });
      gitOps.push({ ts: dayEnd + int(2, 10) * MIN, repo: task.repo, dev, task, type: "merge", message: `Merge branch '${task.branch}'` });
      task = newTask(pick(dev.repos));
      daysLeft = int(...dev.taskDays);
    }
  }
  openTasks.set(dev.name, task);
}

// ---------- git repos (built with git fast-import, then checked out) ----------
function git(cwd: string, args: string[], input?: string) {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trim();
}

const aoife = TEAM[0];
for (const repo of Object.keys(REPOS)) {
  const dir = path.join(code, repo);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const out: string[] = [];
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const who = (dev: Profile, ts: number) => `${dev.name} <${dev.email}> ${Math.floor(ts / 1000)} +0000`;
  let mark = 1;
  let mainMark = 0;
  const branchMark = new Map<string, number>();
  const branchFiles = new Map<string, string[]>();
  const files = new Map<string, string>();

  const initTs = at(DAYS + 5, 10);
  out.push(`commit refs/heads/main\nmark :${mark}\nauthor ${who(TEAM[2], initTs)}\ncommitter ${who(TEAM[2], initTs)}\n${data(`Initial commit of ${repo}`)}M 100644 inline README.md\n${data(`# ${repo}\n`)}`);
  mainMark = mark++;

  for (const op of gitOps.filter((o) => o.repo === repo).sort((a, b) => a.ts - b.ts)) {
    const b = op.task.branch;
    if (op.type === "commit") {
      const parent = branchMark.get(b) ?? mainMark;
      const file = `src/${b}/change-${(branchFiles.get(b)?.length ?? 0) + 1}.ts`;
      const content = `// ${op.message}\nexport const step = ${(branchFiles.get(b)?.length ?? 0) + 1};\n`;
      files.set(file, content);
      branchFiles.set(b, [...(branchFiles.get(b) ?? []), file]);
      out.push(`commit refs/heads/${b}\nmark :${mark}\nauthor ${who(op.dev, op.ts)}\ncommitter ${who(op.dev, op.ts)}\n${data(op.message)}from :${parent}\nM 100644 inline ${file}\n${data(content)}`);
      branchMark.set(b, mark++);
    } else if (branchMark.has(b)) {
      const mods = (branchFiles.get(b) ?? []).map((f) => `M 100644 inline ${f}\n${data(files.get(f)!)}`).join("");
      out.push(`commit refs/heads/main\nmark :${mark}\nauthor ${who(op.dev, op.ts)}\ncommitter ${who(op.dev, op.ts)}\n${data(op.message)}from :${mainMark}\nmerge :${branchMark.get(b)}\n${mods}`);
      mainMark = mark++;
    }
  }
  git(dir, ["fast-import", "--quiet"], out.join("\n") + "\n");

  // Aoife's machine: her open task is checked out with uncommitted work, so Clock out has something to save.
  const open = openTasks.get(aoife.name)!;
  const branches = git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n");
  if (open.repo === repo && branches.includes(open.branch)) {
    git(dir, ["checkout", "-q", "-f", open.branch]);
    fs.mkdirSync(path.join(dir, "src", open.branch), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", open.branch, "work-in-progress.ts"), "// half done: handle the retry backoff\n");
    fs.appendFileSync(path.join(dir, "README.md"), `\nNotes for ${open.key}: still to do.\n`);
  } else {
    git(dir, ["checkout", "-q", "-f", "main"]);
  }
}

// ---------- Claude Code logs for Aoife (this machine) ----------
const claudeDir = paths().claudeDir;
const aoifeMinutes = minutes.get(aoife.name)!;
const bySession = new Map<string, Minute[]>();
for (const m of aoifeMinutes) bySession.set(m.sessionId, [...(bySession.get(m.sessionId) ?? []), m]);
for (const [sessionId, list] of bySession) {
  const cwd = path.join(code, list[0].repo);
  const dir = path.join(claudeDir, "projects", cwd.replace(/[/.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const lines = list
    .sort((a, b) => a.ts - b.ts)
    .map((m) => {
      const base = { sessionId, cwd, gitBranch: m.task.branch, isSidechain: false, timestamp: new Date(m.ts + int(0, 50) * 1000).toISOString() };
      return m.human
        ? JSON.stringify({ ...base, type: "user", message: { role: "user", content: m.prompt } })
        : JSON.stringify({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
    });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

// ---------- past clock-outs and paused agent calls for Aoife ----------
const blockedLog: string[] = [];
const clockouts: { createdAt: number; result: ClockoutResult }[] = [];
for (let d = aoife.clockoutSinceDaysAgo!; d >= 1; d--) {
  if (!lastBlockEnd.get(`${aoife.name}:${d}`)) continue;
  // She clocks out a few minutes after her last prompt, commit or merge of the day.
  const day = dateKey(dayStart(d));
  const lastAction = Math.max(
    ...aoifeMinutes.filter((m) => m.human && dateKey(m.ts) === day).map((m) => m.ts),
    ...gitOps.filter((o) => o.dev === aoife && dateKey(o.ts) === day).map((o) => o.ts),
  );
  const createdAt = lastAction + int(3, 12) * MIN;
  const date = dateKey(createdAt);
  const until = resumeTime(new Date(createdAt), 8);
  const dayMinutes = aoifeMinutes.filter((m) => dateKey(m.ts) === date);
  const repos = [...new Set(dayMinutes.map((m) => m.repo))];
  const days = repos.map((repo) => {
    const prompts = dayMinutes.filter((m) => m.repo === repo && m.prompt);
    const tasks = [...new Set(prompts.map((m) => m.task.key))];
    const lastPrompts = tasks.map((key) => ({ task: key, text: prompts.filter((m) => m.task.key === key).at(-1)!.prompt! }));
    const commits = gitOps.filter((o) => o.dev === aoife && o.repo === repo && o.type === "commit" && dateKey(o.ts) === date).map((o) => o.message);
    return { repo, tasks, commits, uncommitted: [], lastPrompts };
  });
  const tomorrowMd = tomorrowMarkdown(days, date, timeLabel(until));
  clockouts.push({
    createdAt,
    result: {
      date,
      savedRepos: [],
      pauseUntil: until.toISOString(),
      tomorrowPath: path.join(paths().tomorrowDir, `tomorrow-${date}.md`),
      tomorrowMd,
      usedClaudeSummary: false,
      summarySource: null,
      pickupRepos: repos,
    },
  });
  fs.mkdirSync(paths().tomorrowDir, { recursive: true });
  fs.writeFileSync(path.join(paths().tomorrowDir, `tomorrow-${date}.md`), tomorrowMd);
  // Agents left running tried to keep going after she clocked out.
  if (chance(0.7)) {
    for (let k = 0; k < int(1, 4); k++) {
      blockedLog.push(JSON.stringify({ ts: new Date(createdAt + int(40, 300) * MIN).toISOString(), tool: pick(["Bash", "Edit", "Write"]) }));
    }
  }
  if (d === 1) {
    installPickup(
      date,
      days.map((r) => ({ repo: r.repo, path: path.join(code, r.repo), markdown: repoSection(r) })),
      new Date(createdAt),
    );
  }
}
fs.mkdirSync(paths().clockoutHome, { recursive: true });
fs.writeFileSync(paths().blockedLog, blockedLog.join("\n") + "\n");

// The morning pickup already happened in the repo she opened first today.
if (fs.existsSync(paths().pickupState)) {
  const state = JSON.parse(fs.readFileSync(paths().pickupState, "utf8"));
  for (const r of state.repos) {
    const first = aoifeMinutes.find((m) => m.ts >= dayStart(0) && m.human && m.repo === r.repo);
    if (first) r.pickedUpAt = new Date(first.ts).toISOString();
  }
  fs.writeFileSync(paths().pickupState, JSON.stringify(state, null, 2));
}

// ---------- database: users, Aoife's collected data, teammates' agent data ----------
const db = openDb(paths().db);
signIn(db, "Maya", "manager");
const ids = new Map<string, number>();
for (const dev of TEAM) ids.set(dev.name, createDeveloper(db, dev.name, [dev.email]).id);
ensureLocalDevice(db, os.hostname());
linkLocalDevice(db, ids.get(aoife.name)!);

for (const dev of TEAM) {
  if (dev.local || dev.gitOnly) continue;
  const events = new Map<string, ClaudeEvent>();
  for (const m of minutes.get(dev.name)!) {
    const minute = new Date(Math.floor(m.ts / MIN) * MIN).toISOString();
    const id = `${m.sessionId}:${minute}`;
    const e = events.get(id);
    if (e) {
      e.human ||= m.human;
      e.agent ||= m.agent;
    } else events.set(id, { id, ts: minute, sessionId: m.sessionId, repo: m.repo, task: m.task.key, human: m.human, agent: m.agent });
  }
  const payload: CollectPayload = {
    deviceName: `${dev.name.toLowerCase()}-laptop`,
    collectedAt: now.toISOString(),
    localEmails: [dev.email],
    claudeEvents: [...events.values()],
    commits: [], // their commits come from the shared repos
    tasks: [],
    blockedCalls: [],
  };
  ingestPayload(db, ids.get(dev.name)!, payload, false);
}

const { payload } = await collect(now);
ingestPayload(db, ids.get(aoife.name)!, payload, false);
for (const c of clockouts) {
  run(db, "INSERT INTO clockouts (user_id, date, created_at, result_json) VALUES (?, ?, ?, ?)", ids.get(aoife.name)!, c.result.date, new Date(c.createdAt).toISOString(), JSON.stringify(c.result));
}
recomputeAll(db);
db.close();

console.log(`\n  Demo data ready in ${path.relative(root, demo)}/ (rebuilt on every run).`);
console.log("  Sign in as Aoife (developer on this machine), Ben, Chen, Dara or Emeka, or Maya (manager).");
console.log("  Clock out in the demo only touches the demo repos and the demo Claude settings.");

await import("../server/index.js");
