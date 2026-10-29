# Clockout — Requirements

> Status: **v3 — approved 2026-10-29, implemented.** Deviations from the draft are marked *(impl)*.
> Last updated: 2026-10-29

## 1. Problem

AI coding agents compress more work into the same hours. Developers run several Claude Code
sessions in parallel, switch repos and tasks constantly, and lose the natural stopping points of
the day. The result is **compression burnout**: long unbroken stretches, late-night work, and a
morning spent rebuilding context that was never written down. Managers see output going up but
not the load behind it.

## 2. Who it is for

| Persona | Need |
|---|---|
| **Developer** using Claude Code daily | See their own load, stop on time without losing work, start tomorrow without rebuilding context. |
| **Engineering manager** | See each developer's progress per Jira task **next to** their load, so rising output that comes from overwork is visible instead of rewarded. |

## 3. Goal and non-goals

**Goal:** one locally hosted app, started with one command, that:
1. tracks workload and per-task progress from real data,
2. saves open work,
3. writes tomorrow's list,
4. pauses agents until morning,

with a web dashboard for developers and managers.

**Non-goals:**
- No real authentication or OAuth (see §6.1).
- No Jira API integration in v1. Jira task IDs are detected from local data (see §6.4).
- No notifications, nudges or pop-ups during the workday. The product must not add prompts.
- No cloud hosting. Runs on the user's machine.
- No mocked or demo data in the running product.

## 4. Fit with the judging rubric

| Criterion (weight) | How Clockout meets it |
|---|---|
| Takes on the problem (30%) | Directly about compression burnout; names its users; combines two listed ideas (workload tracker + shutdown command). Manager charts always pair output with load. |
| It actually works (30%) | Real Claude Code logs and real git history; end-to-end flow login → collect → dashboards → clock out. No mocks. |
| Someone would use it (20%) | One command to run; README quickstart a stranger can follow; useful every evening. |
| Gives time back (20%) | Zero prompts or alerts; saves the morning context rebuild; enforces a real end to the day. |

## 5. Architecture

One command (`npm start`) starts everything on the local machine.

```
 npm start
   │
   ├─ Server (Node + Fastify, port 4321)
   │    - REST API, simple login, SQLite DB, job queue
   │    - serves the built React frontend
   │
   ├─ Local collector agent (Node, same process tree)
   │    - reads ~/.claude/projects/*/*.jsonl and local git repos
   │    - detects Jira task IDs
   │    - runs clock-out actions (WIP commits, tomorrow.md, pause hook)
   │
   └─ Opens http://localhost:4321 in the browser
```

- **"Trigger an agent":** the dashboard's **Collect now** and **Clock out** buttons create a job;
  the collector picks it up (poll every 5 s), runs it, and reports the result to the dashboard.
- **Multiple developers.** Developer data reaches the server in two real ways, both supported:
  1. **Shared git history (same machine):** commits by other authors in local repos are
     attributed to the developer whose git email matches (FR-9a). This gives the manager a
     multi-developer view from one machine with no fake data.
  2. **Remote agents (other machines):** a developer runs
     `npm run agent -- --server http://<host>:4321 --user <name>` to send full metrics (Claude
     Code logs + git) to the shared instance. Requires the server to be started with `--lan`;
     by default it listens on `127.0.0.1` only.

### Stack

- TypeScript throughout, Node 22+.
- Server: Fastify. Database: SQLite via Node's built-in `node:sqlite` (no native build step).
- Frontend: React + Vite. Charts: Recharts (pie, bar, line, area, Sankey).
- Collector: Node, no extra runtime dependencies beyond the server's.
- Claude summary: `@anthropic-ai/sdk`, optional.
- Tests: Vitest with fixture log files and temporary git repos.

## 6. Functional requirements

### 6.1 Login (no auth)

- **FR-1** Login page with a name field, a role choice (**Developer** / **Manager**) and a
  **Sign in** button. No password, no OAuth.
- **FR-2** Any number of developers can sign in. First sign-in with a new name creates the user;
  later sign-ins reuse it. Developers can also be seen on the login page as a list of existing
  names for one-click sign-in.
- **FR-2a** A developer adds one or more git author emails on their profile (pre-filled from
  `git config user.email` for the local user). Used for commit attribution (FR-9a).
- **FR-3** The developer who signs in on the machine running `npm start` is linked to the local
  collector (their Claude Code logs). Can be changed in settings.
- **FR-4** There is exactly **one manager** in the system. The first user to sign in as Manager
  becomes the manager; later attempts to sign in as Manager with another name are refused with a
  clear message. The manager sees **every developer** in the system. No teams.
- **FR-4a** The manager can rename or remove developers and reassign git emails.
- **FR-5** Session is a cookie; **Sign out** clears it. Several browser profiles can be signed in
  as different users at the same time.
- **FR-6** README states clearly: this login is for local, trusted use only and is not access control.

### 6.2 Collector agent

- **FR-7** Starts with `npm start` for the local user. No pairing step needed locally.
- **FR-8** Remote agents (optional, §5) register by user name and get a device token stored in
  `~/.clockout/config.json` (file mode `600`).
- **FR-9** Dashboard shows agent status: connected, last run time, last error.
- **FR-9a** Git attribution: the collector reads commits from all authors in scanned repos and
  assigns each commit to the developer whose git emails match. Commits from unknown emails are
  listed in the manager's settings as "Unmatched authors" with a one-click **Create developer**.
- **FR-9b** For developers without Claude Code logs on the server (git-only data), activity
  blocks are built from commit timestamps. The dashboard marks these metrics as
  "git-only, less precise".

### 6.3 Feature 1 — Workload tracker

Data sources (local, read-only):
- Claude Code session logs: `~/.claude/projects/*/*.jsonl` (timestamps, session ids, project path,
  user prompts, git branch where recorded).
- Git: `git log`, `git status`, branch names for repos found in Claude Code logs, plus configured
  roots (default `~/` depth 3).

Metrics per developer per day (computed by the collector):
- **FR-10** Active span: first activity → last activity.
- **FR-11** Active time: sum of activity blocks (gap > 15 min ends a block).
- **FR-12** Longest stretch without a break (break = gap ≥ 15 min).
- **FR-13** Last break time.
- **FR-14** Peak parallel Claude Code sessions.
- **FR-15** Repos touched; context switches (project or task changes between blocks).
- **FR-16** Late-night activity (after a configurable hour, default 20:00) and weekend activity.
- **FR-17** Commits authored.
- **FR-18** **Load score** 0–100 combining the above; formula documented in the README.

Developer dashboard:
- **FR-19** Today card: active time, longest stretch, last break, parallel sessions, repos touched.
- **FR-20** 14-day activity timeline and load-score trend.
- **FR-21** **Collect now** button that triggers the collector and refreshes when done.

### 6.4 Jira task tracking

- **FR-22** Detect Jira keys with pattern `[A-Z][A-Z0-9]+-\d+` (e.g. `PAY-142`) in, in priority
  order: git branch name, commit messages, Claude Code prompts.
- **FR-23** Attribute each activity block to a task: the key found on the active branch, else the
  most recent key in that session's prompts, else `Unassigned`.
- **FR-24** Per task, record: developer, repo, active minutes, Claude Code sessions, commits,
  first seen, last seen.
- **FR-25** Task status inferred from git, no Jira API:
  - `In progress` — activity in the last 3 days.
  - `Done` — branch merged into the default branch, or commit on the default branch mentions the key.
  - `Stalled` — no activity for 3+ days and not done.
- **FR-26** Cycle time for done tasks: first seen → merge.
- **FR-27** Optional Jira base URL setting (e.g. `https://acme.atlassian.net`) turns task keys
  into links. No API calls.

### 6.5 Manager dashboard

Team overview:
- **FR-28** KPI tiles: tasks done this week, median cycle time, team active hours, developers
  over the load threshold.
- **FR-29** Table of developers: load score, active time, longest stretch, late-night days,
  tasks in progress / done (last 14 days). Row click opens the developer detail.

Charts:
- **FR-30** **Pie** — share of team time per Jira task (top 8 + "Other"), and per developer.
- **FR-31** **Sankey** — developer → Jira task → status (`Done` / `In progress` / `Stalled`),
  link width = active hours.
- **FR-32** **Stacked bar** — tasks done per developer per week (last 6 weeks).
- **FR-33** **Line** — load score per developer over 14/30 days.
- **FR-34** **Load vs output scatter** — per developer per week: x = active hours, y = tasks done.
  Highlights developers whose output rises only with hours (the burnout signal).
- **FR-35** **Cycle-time trend** — median cycle time per week, to show improvement.

Developer detail (manager view):
- **FR-36** Tasks list with key, status, active hours, commits, cycle time.
- **FR-37** Weekly progress: tasks done, active hours, load score, late-night minutes.

Filters and transparency:
- **FR-38** Date range (7 / 14 / 30 days) and developer filter on all charts.
- **FR-39** A developer can open **What my manager sees** and see exactly the same charts about themselves.

### 6.6 Feature 2 — Save open work

- **FR-40** On clock out, for every repo with uncommitted changes, create a WIP commit on branch
  `clockout/YYYY-MM-DD` and return to the original branch with the working tree unchanged.
  *(impl)* Limited to repos with the developer's activity in the last 7 days, so old clones under `~/` are left alone.
  The commit is built with a temporary index, so nothing is checked out at all.
- **FR-41** Never pushes. Never rewrites history. Never commits to the current branch.
- **FR-42** Skips repos in the middle of a merge/rebase and reports them.
- **FR-43** Result listed in the clock-out summary (repo, branch, files saved).

### 6.7 Feature 3 — Tomorrow's list

- **FR-44** Writes `~/clockout/tomorrow-YYYY-MM-DD.md` and shows it in the developer dashboard.
  Per Jira task and repo touched today: last commits, saved WIP branch, uncommitted files, last
  request sent to Claude Code.
- **FR-45** Base content is generated deterministically from data.
- **FR-46** If `ANTHROPIC_API_KEY` is set, add a short Claude-written "where you left off" summary
  per task (model configurable via `CLOCKOUT_MODEL`). *(impl)* Default `claude-opus-5-5`, the current default model. If missing or failing, fall back to
  FR-45 output with no error shown to the user.
- **FR-47** Tomorrow's list is visible only to its owner, never in the manager dashboard.

### 6.8 Feature 4 — Pause agents until morning

- **FR-48** On clock out, install a Claude Code `PreToolUse` hook in `~/.claude/settings.json`
  that blocks tool calls until resume time (default 08:00 next workday) with the message:
  "Clocked out until 08:00. Run `npm run resume` or press Resume in Clockout to override."
- **FR-49** The hook removes itself after the resume time.
- **FR-50** **Resume** button and `npm run resume` remove the hook immediately.
- **FR-51** Existing settings and hooks are preserved; backup written before editing.

### 6.9 Clock-out flow

- **FR-52** Triggered by the **Clock out** button or `npm run clockout`. Same result.
- **FR-53** Order: collect → save open work → write tomorrow's list → pause agents → summary
  (today's load, tasks worked, saved repos, tomorrow's list, pause-until time).
- **FR-54** No questions asked during the flow. Only a developer can clock themselves out.

## 7. Non-functional requirements

- **NFR-1** One command after clone: `npm install && npm start` (or `npm start` running install
  on first use). Opens the browser.
- **NFR-2** macOS and Linux. Windows best-effort.
- **NFR-3** Collecting 30 days of logs completes in < 10 s.
- **NFR-4** Empty states: no Claude Code logs, no git repos, or no Jira keys show a clear message,
  not an error. Charts show "No data yet — press Collect now".
- **NFR-5** Tests use fixture logs and temporary git repos; at least one end-to-end test covers
  login → collect → manager charts → clock out → resume.

## 8. Data model (initial)

- `User` (id, name, role `developer|manager`, isLocal) — at most one `manager`
- `GitIdentity` (email, userId)
- `Device` (id, userId, name, tokenHash, lastSeenAt)
- `DailyMetrics` (userId, date, source `claude+git|git-only`, activeMinutes, spanMinutes, longestStretchMinutes, lastBreakAt,
  peakParallelSessions, reposTouched, contextSwitches, lateNightMinutes, commits, loadScore)
- `Task` (key, repo, status, firstSeenAt, lastSeenAt, doneAt)
- `TaskActivity` (taskKey, userId, date, activeMinutes, sessions, commits)
- `Job` (id, userId, type `collect|clockout|resume`, status, createdAt, finishedAt, resultJson)
- `ClockoutSummary` (userId, date, savedRepos, pauseUntil, tomorrowMd)

## 9. Privacy and security

- Manager sees: aggregate metrics, Jira task keys, time and commit counts per task, task status.
- Manager never sees: prompt text, code, diffs, file names, commit messages, tomorrow's list.
- No real access control (FR-6). Server binds to `127.0.0.1` by default; `--lan` is opt-in and
  the README warns that anyone on the network can then sign in as anyone.
- `ANTHROPIC_API_KEY` only from environment / `.env`; `.env` git-ignored, `.env.example` committed.
- Collector performs only local git operations listed in FR-40–42; no network git operations.

## 10. Acceptance criteria (demo path)

1. Clone → `npm install && npm start` → browser opens the login page.
2. Sign in as a Developer → **Collect now** → today's card, timeline and task list show real data.
3. Sign in as a second and third Developer (other browser profile), each with their git email →
   their commits from shared repos appear on their dashboards.
4. Sign in as the Manager → every developer is listed; KPI tiles, pie, Sankey, bar, line,
   scatter and cycle-time charts render across all developers from real data. A second Manager
   sign-in with another name is refused.
5. Developer opens **What my manager sees** → same charts.
6. Developer presses **Clock out** → WIP branches created, tomorrow's list (with Claude summary
   when a key is set) shown, Claude Code tool calls blocked.
7. **Resume** → block removed.

## 11. Decisions log

| # | Decision | Answer |
|---|---|---|
| 1 | Stack | TypeScript (Node, Fastify, React, Vite, SQLite, Recharts). |
| 2 | Auth | No auth. Name + role + Sign in button. |
| 3 | Hosting | Local machine, one command. |
| 4 | Claude summary in tomorrow's list | Yes, optional via `ANTHROPIC_API_KEY`. |
| 5 | Manager view | Charts of developer progress per Jira task (pie, Sankey, bar, line, scatter), always shown next to load. |
| 6 | Users | Many developers can sign in; exactly one manager who sees every developer. No teams. Multi-developer data from shared git history (by author email) and optional remote agents. |
| 7 | Jira key format | `[A-Z][A-Z0-9]+-\d+` (e.g. `PAY-142`). |

## 12. v4 additions (approved 2026-10-29, implemented)

- **FR-55 You vs your agents.** Claude Code activity is split per minute into the developer's own actions (prompts,
  slash commands, `!` commands) and Claude's output. Hands-on time, breaks, longest stretch, context switches, late night
  and the load score use only the developer's actions and commits. Agent time, and the part of it outside the
  developer's blocks, is reported separately per day and per task.
- **FR-56 Morning pickup.** Clock out installs a `SessionStart` hook. After the pause ends, the first new session inside
  each repo from tomorrow's list gets that repo's notes as context, once. Self-removing; expires after 4 days.
- **FR-57 Claude notes without an API key.** Without `ANTHROPIC_API_KEY`, the "where you left off" notes come from the
  developer's `claude` CLI (`-p`, no tools, hooks disabled, no session persistence), excluded from metrics.
- **FR-58 Time given back.** Developer dashboard shows the last clock-out against the 14-day usual finish (real finish if
  they kept working), evenings given back this week, after-hours agent calls paused (logged by the pause hook), and
  late-night minutes against the same days last week.

## 13. Remaining open points

None. Ready for approval.
