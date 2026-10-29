# Clockout

**Ease compression burnout for developers who work with Claude Code.**

AI agents fit more work into the same hours. You run several Claude Code sessions at once, jump between repos and
tasks, and the day loses its natural stopping points. Clockout shows how much you are really juggling, and gives you one
button to end the day properly:

1. **Workload tracker** — your hands-on time, longest stretch without a break, parallel sessions, context switches
   and late-night work, from your real Claude Code logs and git history. Claude's working time is measured separately,
   so a long agent run never hides a break or stretches your day.
2. **Save open work** — uncommitted changes go to a `clockout/<date>` branch. Your working tree and current branch are
   never touched, and nothing is pushed.
3. **Tomorrow's list** — a short note per repo and Jira task: what you last asked Claude, today's commits, saved work and
   uncommitted files, plus a Claude-written "where you left off" line. That line uses your existing Claude Code login,
   so no API key is needed.
4. **Pause agents until morning** — a Claude Code hook blocks tool calls until 08:00 on the next workday. Press
   **Resume** to undo.
5. **Morning pickup** — the next morning, the first Claude Code session you start in each repo already has that repo's
   notes, so Claude knows where you left off and you don't have to explain it again.

The dashboard also shows the **time given back**: how much earlier you stopped than your usual finish, how many agent
tool calls were paused after hours, and your late-night work compared with last week.

**Who it's for:**

- **Developers** who use Claude Code daily and want to stop on time without losing context.
- **Engineering managers** who want to see progress per Jira task *next to the load behind it*. If output only goes up
  when hours go up, that's burnout coming, not productivity.

It fits two ideas from the brief: *a workload tracker* and *a shutdown command*.

## Quickstart

Requires **Node.js 22.13+** and **git**. Runs on macOS and Linux.

```bash
git clone <this repo> clockout && cd clockout
npm install
npm start
```

`npm start` builds the web app, starts the server and the local agent, and opens <http://localhost:4321>.

1. Sign in with your name as a **Developer**. There is no password. The first developer to sign in on this machine is
   linked to the local agent, which then reads this machine's Claude Code logs.
2. Your dashboard fills in within a few seconds. Press **Collect now** at any time to refresh it.
3. When you're done for the day, press **Clock out**.
4. Next morning the pause ends by itself. Press **Resume** (or run `npm run resume`) to unblock earlier.

To see the manager view, open a second browser profile and sign in as a **Manager**.

### Demo with a sample team

```bash
npm run demo
```

Opens <http://localhost:4322> with a generated team instead of your data, so you can see every chart filled in:

- **Who's in it:** Aoife (the developer on "this machine"), Ben (overloaded: long days, late nights, little merged),
  Chen (steady), Dara (git only, no Claude Code) and Emeka (joined three weeks ago). Sign in as **Maya** for the
  manager view.
- **How it's made:** `scripts/demo.ts` builds everything in `./.demo/`: three real git repos with six weeks of task
  branches and merges, Claude Code session logs for Aoife, agent data for her teammates (sent the way a remote agent
  sends it), and a week of Aoife's past clock-outs. The normal collector and server then read it. Dates are relative
  to today, and the folder is rebuilt on every run.
- **Safe to click everything:** the demo points every path at `./.demo/`, so **Clock out** saves work in the demo
  repos and pauses only the demo's Claude settings. Your real `~/.claude`, repos and Clockout data are untouched.
- **No Claude calls:** the demo skips the Claude-written notes. Run `CLOCKOUT_SUMMARY=on npm run demo` to include them
  (uses your `claude` login).
- **Can run beside the real app:** the demo uses port 4322, `npm start` uses 4321. The yellow banner marks demo data.

`npm start` never shows demo data: it only reads your own Claude Code logs and repos.

> Clock out really does change things on your machine: it creates `clockout/*` branches in repos with uncommitted
> changes and adds a hook to `~/.claude/settings.json`. A backup of your settings goes to `~/.clockout/backups/` first.
> Resume removes the hook again.

## Using it

### Developer dashboard

- **Today:** your hands-on time, your agents' time (and how much of it ran on its own), longest stretch, last break,
  peak parallel sessions, context switches and the load score.
- **Time given back:** last clock-out compared with your usual finish (average of the last 14 days), evenings given back
  this week, agent tool calls paused after hours, and late-night minutes compared with the same days last week. If you
  resume and keep working after clocking out, your real finish counts, not the button press.
- **Last 14 days:** a timeline of when you worked and when Claude kept going on its own, with your late-night blocks in
  red, plus your load trend.
- **My tasks:** Jira tasks with status, your time, agent time, commits and cycle time.
- **Last clock-out:** saved branches and tomorrow's list. Only you can see tomorrow's list.
- **What my manager sees:** exactly the charts your manager sees about you.
- **Settings:** your git emails, and linking this machine's agent to you.

### Manager dashboard

There is exactly one manager. The first person to sign in as Manager takes the role, and the manager sees every developer.

- **KPI tiles:** tasks done this week, median cycle time, active hours, and developers over the load threshold.
- **Developers table:** load, active hours, longest stretch, late-night days and tasks per developer. Select a row
  for that developer's tasks and weekly progress.
- **Charts:**
  - Pie of time per Jira task, and pie of time per developer.
  - Sankey from developer to task to status, so you see where effort went and whether it finished.
  - Tasks done per week, per developer.
  - Load score per developer over time, with the overload threshold.
  - **Load vs output**: one dot per developer per week. More hours without more tasks done is the burnout signal.
  - Median cycle time per week.
- **People:**
  - Add or rename developers and set their git emails.
  - **Unmatched authors** lists commit authors from collected repos with a one-click **Create developer**.
- **Settings:** Jira base URL (turns keys into links; no API calls), late-night hour, resume hour and load threshold.

### Several developers

Developer data reaches the manager in two real ways. Nothing is simulated.

1. **Shared git history on one machine:** commits in local repos are matched to developers by git email. A
   teammate's commits count as theirs as soon as their email is added under **People**, or in their own **Settings**.
   These developers are marked *git-only*, because their activity is estimated from commit times only.
2. **Remote agents:** start the server with `npm start -- --lan`. Then, on each teammate's machine (in a clone of this
   repo), run:

   ```bash
   npm install
   npm run agent -- --server http://<manager-host>:4321 --user <their name>
   ```

   Their agent sends full metrics, including Claude Code activity, and runs their **Collect now** and **Clock out**
   jobs on their machine.

> `--lan` has no access control. Anyone on the network can open the app and sign in as anyone. Use it only on networks
> you trust. Without `--lan`, Clockout answers only requests addressed to `localhost` from `localhost` pages, so a web
> page on another site can't reach it, even through DNS rebinding.

### Command line

```bash
npm run today      # your day in the terminal: hands-on time, agents, breaks, tasks, last 7 days
npm run clockout   # same as the Clock out button (works even when the server is not running)
npm run resume     # unblock Claude Code now
```

None of these need the server or a browser. `npm run today` reads your logs and git directly (a few seconds) and
stores nothing.

### Start at login

```bash
npm run autostart              # macOS (launchd) or Linux (systemd user service)
npm run autostart -- --remove  # undo
```

The dashboard then always runs at <http://localhost:4321> without a terminal window, and restarts if it crashes.
Logs go to `~/.clockout/server.log`. `PORT` and `CLOCKOUT_*` settings in your environment carry over to the service;
`ANTHROPIC_API_KEY` is never written to the service file (the notes then use your `claude` login). If you run
`npm start` while the service is up, it tells you Clockout is already running instead of failing.

### Inside Claude Code

```bash
npm run setup-claude              # add the status line and the /clockout commands
npm run setup-claude -- --remove  # take them out again
```

Then start a new Claude Code session:

- **Status line** at the bottom of Claude Code, for example
  `Clockout · 2h10m hands-on today · 52m since your last break`, or `on a break since 14:10`, or
  `clocked out until Friday 08:00`. It counts only your own prompts, reads today's logs incrementally (about 50 ms per
  refresh) and never alerts. If you already have a status line, Clockout keeps yours and prints how to switch.
- **`/clockout`** clocks out without leaving Claude Code: it runs `npm run clockout` and Claude sums up what was saved,
  where tomorrow's list is and until when agents are paused. Claude never runs it on its own.
- **`/clockout-resume`** unblocks tools early. It works even while tools are paused.

The commands are personal skills in `~/.claude/skills/clockout*/` and point at this folder, so keep the folder where it
is or run `npm run setup-claude` again after moving it.

## How it works

```
npm start
  ├─ Server (Fastify + SQLite)  REST API, sign-in, job queue, serves the React app
  ├─ Local agent (in process)   reads ~/.claude/projects/*/*.jsonl and local git repos,
  │                             runs Collect / Clock out / Resume jobs
  └─ Browser                    http://localhost:4321
```

The dashboard's buttons create a **job**. The agent that belongs to that developer picks it up, runs it on their
machine and reports back. The local agent handles jobs straight away; remote agents check every 5 seconds.

### What is measured

| Metric | Definition |
|---|---|
| Your activity | Minutes in which you typed into Claude Code (a prompt, a slash command or a `!` command), plus your commits. Tool results, command output and other system messages don't count. |
| Agent activity | Minutes in which Claude produced output. Measured separately and never counted as your time. |
| Block | Your activity with gaps under 15 minutes. **15 minutes without a prompt or commit from you is a break**, even if Claude keeps working. A single action counts as 5 minutes. |
| Hands-on time | Sum of your blocks. |
| Agent time | Minutes Claude was working; "on its own" is the part outside your blocks. |
| Longest stretch | Your longest block. |
| Parallel sessions | Peak number of Claude Code sessions active at the same time. |
| Context switches | Times you moved to another repo, Jira task or Claude Code session between one action and the next. |
| Late night | Your minutes after the late-night hour (default 20:00) or before 06:00. |
| Finish | Your last action of the evening. Work until 05:00 counts as the previous evening. |

**Load score (0–100)** is the sum of five parts, each capped:

```
35 × min(active minutes / 600, 1)        # 10 h of activity
20 × min(longest stretch / 240, 1)       # 4 h without a break
15 × min((parallel sessions − 1) / 3, 1) # 4 sessions at once
15 × min(late-night minutes / 120, 1)    # 2 h late at night
15 × min(context switches / 20, 1)       # 20 switches
```

A developer is **over the threshold** when their 7-day average load is at or above 60 (configurable).

### Jira tasks

- **Key pattern:** keys look like `[A-Z][A-Z0-9]+-\d+`, for example `PAY-142`. Look-alikes such as `UTF-8` and
  `SHA-256` are ignored.
- **Where keys come from**, in priority order:
  1. The git branch name, both for Claude Code sessions and for commits that are not merged yet.
  2. The commit message, or the key of the merge that brought the commit into the default branch.
  3. The latest key mentioned in that Claude Code session's prompts.

  Time without a key counts as **Unassigned**.
- **Time per task:** your hands-on time goes to the task you were working on; agent time is counted per task too.
- **Status**, inferred from git with no Jira API:
  - **Done:** merged into the default branch. That means a merge or squash commit on the default branch's main line
    mentions the key, or a branch named after the key is merged.
  - **In progress:** activity in the last 3 days.
  - **Stalled:** no activity for 3+ days and not done.
- **Cycle time:** first activity on the task until it was merged.

### Privacy

- **Managers see:** numbers, repo names, Jira keys, time per task and task status.
- **Managers never see:** prompt text, code, diffs, file names, commit messages or tomorrow's list.
- **The agent sends no content:** it sends only timestamps, repo names, Jira keys and commit authors to the server.
  Tomorrow's list (which quotes your prompts) is stored only for you.
- **Where data lives:** in `~/.clockout/clockout.db`. Tomorrow's lists are written to `~/clockout/`.

### Clock out in detail

1. Collect fresh metrics.
2. Save open work in every repo you were active in during the last 7 days:
   - Clockout builds a commit with a **temporary git index** and points `clockout/<date>` at it. That commit holds
     tracked and untracked files, and respects `.gitignore`.
   - Your working tree, your staged changes and your current branch stay exactly as they were.
   - Repos in the middle of a merge, rebase or cherry-pick are skipped and reported.
   - To restore: `git checkout clockout/<date> -- .`
3. Write `~/clockout/tomorrow-<date>.md`. The "where you left off" line per repo comes from Claude:
   - With `ANTHROPIC_API_KEY` set, through the Claude API.
   - Otherwise through your installed `claude` CLI and its existing login, run headless: no tools, hooks turned off,
     nothing saved to your session history, and Clockout's own folder is excluded from your metrics.
   - If neither works, the list is still written from your data alone.
4. Install the pause hook:
   - It adds a `PreToolUse` hook to `~/.claude/settings.json` that runs `~/.clockout/pause-hook.mjs`.
   - The hook exits with code 2 (block) and tells Claude Code that you're clocked out.
   - Each blocked call is logged to `~/.clockout/blocked.log` (time and tool name only); the dashboard counts them.
   - After the resume time, the hook removes itself.
5. Install the morning pickup hook:
   - It adds a `SessionStart` hook (matcher `startup`) that runs `~/.clockout/pickup-hook.mjs`.
   - Once you're no longer clocked out, the first new Claude Code session inside each repo from tomorrow's list gets
     that repo's notes as context. Resumed sessions and sessions outside those repos get nothing.
   - Each repo is picked up once. The hook removes itself when every repo is picked up, or after 4 days.

Your other settings and hooks are kept, and `~/.claude/settings.json` is backed up before each change.

## Configuration

Copy `.env.example` to `.env`, or export the variables:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Writes the "where you left off" notes through the Claude API. Without it, Clockout uses your `claude` CLI login. |
| `CLOCKOUT_MODEL` | `claude-opus-5-5` with an API key; your Claude Code default otherwise | Model used for those notes. |
| `CLOCKOUT_SUMMARY` | — | Set to `off` to skip the Claude-written notes entirely. |
| `CLOCKOUT_CLAUDE_BIN` | found on `PATH` | Path to the `claude` CLI, if it's somewhere unusual. |
| `PORT` | `4321` | Server port. |
| `CLOCKOUT_SCAN_ROOTS` | your home folder | Colon-separated folders to search for git repos (3 levels deep). Repos from Claude Code logs are always included. |
| `CLOCKOUT_HOME` | `~/.clockout` | Database, pause state, backups. |
| `CLAUDE_DIR` | `~/.claude` | Claude Code folder (logs and settings). |
| `CLOCKOUT_TOMORROW_DIR` | `~/clockout` | Where tomorrow's lists are written. |
| `CLOCKOUT_NO_OPEN` | — | Set to `1` to stop `npm start` opening a browser. |

## Development

```bash
npm test          # Vitest: metrics, git, hooks, Claude notes, and a full end-to-end flow
npm run typecheck
npx vite          # frontend dev server with hot reload (proxies /api to :4321)
```

Tests run against temporary folders, fixture Claude Code logs and throwaway git repos. They never touch your real
home folder.

```
shared/   types, paths, Jira key detection
agent/    collector: Claude logs, git, save work, tomorrow's list, pause hook, job runner, remote agent, CLI
server/   Fastify app, SQLite schema, metrics, dashboard queries, in-process local agent
web/      React + Recharts frontend
test/     Vitest suites
```

## Limitations

- **Sign-in is not access control.** It is meant for a local machine or a trusted network.
- **Git-only developers are less precise:** their active time is estimated from commit times.
- **Reading isn't activity:** time spent reading Claude's output or code without typing counts as a break after 15
  minutes. That keeps breaks honest, but it can undercount long review sessions.
- **Done means merged:** task status comes from git, not Jira, so a task closed in Jira but never merged stays open.
- **Platforms:** Windows is untested.
