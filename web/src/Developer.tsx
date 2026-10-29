import { useCallback, useEffect, useState } from "react";
import { api, type Day, type DeveloperDetail, type DeveloperOverview, type Job, type ManagerOverview, type Me, type TimeBack, type Workday } from "./api";
import { ActivityTimeline, LoadTrendSingle } from "./charts";
import { Card, DeveloperProgress, Markdown, StatusBadge, TaskKey, TeamCharts, Tile } from "./components";
import { ago, clock, dateTime, hhmm, hm } from "./format";

type Tab = "day" | "manager" | "settings";

const JOB_LABEL: Record<Job["type"], string> = {
  collect: "Collecting",
  clockout: "Clocking out",
  resume: "Resuming",
  "auto-clockout": "Clocking out (end of workday)",
  "auto-wrapup": "Writing tomorrow's list (end of workday)",
};

export function DeveloperPage({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  const [tab, setTab] = useState<Tab>("day");
  const [o, setO] = useState<DeveloperOverview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const data = await api<DeveloperOverview>("GET", "/api/me/overview");
    setO(data);
    if (data.latestJob && (data.latestJob.status === "pending" || data.latestJob.status === "running")) setJob(data.latestJob);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll the running job, refresh when it finishes.
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    const t = setTimeout(async () => {
      const { job: next } = await api<{ job: Job }>("GET", `/api/jobs/${job.id}`);
      setJob(next);
      if (next.status === "done") void load();
      if (next.status === "failed") setError(next.error ?? "The agent failed.");
    }, 1000);
    return () => clearTimeout(t);
  }, [job, load]);

  const start = async (type: Job["type"]) => {
    setError("");
    try {
      const { job } = await api<{ job: Job }>("POST", "/api/jobs", { type });
      setJob(job);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!o) return null;
  const busy = !!job && (job.status === "pending" || job.status === "running");
  const t = o.today;
  const noAgent = o.agent.length === 0;

  return (
    <main className="page">
      <div className="spread">
        <div>
          <div className="eyebrow">{new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</div>
          <h1>Hi {me.user.name}.</h1>
        </div>
        <div className="row">
          {!busy && me.workday && me.workday.mode !== "off" && (
            <span className="secondary small">
              {me.workday.mode === "clockout" ? "Clocks out" : "Writes tomorrow's list"} at {me.workday.endTime} on weekdays
            </span>
          )}
          {busy && <span className="secondary small">{JOB_LABEL[job!.type]}…</span>}
          <button onClick={() => start("collect")} disabled={busy || noAgent}>
            Collect now
          </button>
          {o.paused ? (
            <button className="primary" onClick={() => start("resume")} disabled={busy}>
              Resume
            </button>
          ) : (
            <button className="primary" onClick={() => start("clockout")} disabled={busy || noAgent}>
              Clock out
            </button>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {o.paused && o.clockout?.pauseUntil && (
        <div className="banner paused">
          <span>
            You're clocked out. Claude Code tools are paused until <b>{dateTime(o.clockout.pauseUntil!)}</b>.
          </span>
          <button onClick={() => start("resume")} disabled={busy}>
            Resume now
          </button>
        </div>
      )}
      {noAgent && <NoAgent me={me} onLinked={() => { reloadMe(); void load(); setTab("day"); }} />}

      <nav className="tabs">
        <button className={tab === "day" ? "on" : ""} onClick={() => setTab("day")}>My day</button>
        <button className={tab === "manager" ? "on" : ""} onClick={() => setTab("manager")}>What my manager sees</button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Settings</button>
      </nav>

      {tab === "day" && (
        <>
          {!o.hasData && !noAgent && <div className="notice">No activity yet. Press <b>Collect now</b> to read your Claude Code logs and git history.</div>}
          <div className="tiles">
            <Tile label="You, today" value={hm(t.activeMinutes)} hint={t.spanMinutes ? `hands-on, across a ${hm(t.spanMinutes)} day` : "no prompts or commits yet"} />
            <Tile label="Your agents" value={hm(t.agentMinutes)} hint={t.agentSoloMinutes ? `${hm(t.agentSoloMinutes)} of it on their own` : "Claude working time"} />
            <Tile label="Longest stretch" value={hm(t.longestStretchMinutes)} hint="your own work, no 15-min break" />
            <Tile label="Last break" value={clock(t.lastBreakAt)} hint={t.lastBreakAt ? "ended at" : "no break yet today"} />
            <Tile label="Parallel sessions" value={t.peakParallelSessions} hint="peak Claude Code sessions at once" />
            <Tile label="Context switches" value={t.contextSwitches} hint={`across ${t.reposTouched} ${t.reposTouched === 1 ? "repo" : "repos"}`} />
            <Tile label="Load score" value={t.loadScore} hint={<LoadBreakdown parts={t.loadParts} />} />
          </div>

          <TimeGivenBack tb={o.timeBack} />

          {o.clockout && <ClockoutSummary c={o.clockout} pickup={o.pickup} />}

          <div className="grid-2">
            <Card title="Last 14 days" sub="When you were working, and when Claude kept going on its own. 15 minutes without a prompt or commit from you is a break.">
              <ActivityTimeline days={o.days} lateHour={me.settings.lateHour} />
            </Card>
            <Card title="Load score" sub="Daily, last 14 days">
              <LoadTrendSingle days={o.days} threshold={me.settings.loadThreshold} />
            </Card>
          </div>

          <Card title="My tasks" sub="Jira keys found in your branches, commits and Claude prompts">
            {o.tasks.length === 0 ? (
              <div className="empty">No Jira keys found yet. Put keys like PAY-142 in branch names, commit messages or Claude prompts.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Status</th>
                      <th>Repo</th>
                      <th className="num">My time</th>
                      <th className="num">Agent time</th>
                      <th className="num">Commits</th>
                      <th className="num">Cycle time</th>
                      <th>Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.tasks.map((task) => (
                      <tr key={task.key}>
                        <td><TaskKey k={task.key} jiraBaseUrl={me.settings.jiraBaseUrl} /></td>
                        <td><StatusBadge status={task.status} /></td>
                        <td className="secondary">{task.repos.join(", ")}</td>
                        <td className="num">{hm(task.myMinutes)}</td>
                        <td className="num">{task.myAgentMinutes ? hm(task.myAgentMinutes) : "—"}</td>
                        <td className="num">{task.commits}</td>
                        <td className="num">{task.cycleDays != null ? `${task.cycleDays} d` : "—"}</td>
                        <td className="secondary">{ago(task.lastSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <AgentStatus o={o} />
        </>
      )}

      {tab === "manager" && <ManagerView me={me} />}
      {tab === "settings" && <DevSettings me={me} o={o} onSaved={() => { reloadMe(); void load(); }} />}
    </main>
  );
}

function ClockoutSummary({ c, pickup }: { c: NonNullable<DeveloperOverview["clockout"]>; pickup: DeveloperOverview["pickup"] }) {
  const pickedUp = new Map((pickup?.date === c.date ? pickup.repos : []).map((r) => [r.repo, r.pickedUpAt]));
  const saved = c.savedRepos.filter((s) => s.status === "saved");
  const skipped = c.savedRepos.filter((s) => s.status === "skipped");
  return (
    <div className="grid-2">
      <Card
        title={c.pauseUntil ? "Last clock-out" : "Last wrap-up"}
        sub={`${dateTime(c.createdAt)}${c.auto ? " · end of workday" : ""}${c.resumedAt ? ` · resumed ${ago(c.resumedAt)}` : ""}`}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <div>
            {c.pauseUntil ? (
              <>
                Agents paused until <b>{dateTime(c.pauseUntil)}</b>.
              </>
            ) : (
              "Tomorrow's list is written. Agents were not paused."
            )}
          </div>
          {saved.length === 0 && skipped.length === 0 && <div className="secondary">No uncommitted work to save.</div>}
          {saved.map((s) => (
            <div key={s.repo}>
              ✓ Saved <b>{s.repo}</b> to <code>{s.branch}</code> ({s.files} {s.files === 1 ? "file" : "files"})
            </div>
          ))}
          {skipped.map((s) => (
            <div key={s.repo} className="secondary">
              Skipped {s.repo}: {s.reason}
            </div>
          ))}
          {!!c.pickupRepos?.length && (
            <div>
              Tomorrow's first Claude Code session in{" "}
              {c.pickupRepos.map((r, i) => (
                <span key={r}>
                  {i > 0 && ", "}
                  <b>{r}</b>
                  {pickedUp.get(r) ? <span className="secondary"> (picked up {clock(pickedUp.get(r)!)})</span> : null}
                </span>
              ))}{" "}
              starts with these notes, so Claude knows where you left off.
            </div>
          )}
          {!!c.prunedBranches && (
            <div className="secondary small">
              Removed {c.prunedBranches} old <code>clockout/*</code> {c.prunedBranches === 1 ? "branch" : "branches"} (older than 14 days).
            </div>
          )}
          <div className="muted small">
            Tomorrow's list saved to <code>{c.tomorrowPath}</code>
            {c.usedClaudeSummary ? ` · "where you left off" written by Claude${c.summarySource === "claude-code" ? " via your Claude Code login" : ""}` : ""}
          </div>
        </div>
      </Card>
      <Card title="Tomorrow's list" sub="Only you can see this.">
        <Markdown text={c.tomorrowMd} />
      </Card>
    </div>
  );
}

function TimeGivenBack({ tb }: { tb: TimeBack }) {
  const last = tb.last;
  const usual = tb.usualFinishMinutes;
  const lateDelta = tb.lateNight.thisWeek - tb.lateNight.lastWeek;
  return (
    <Card title="Time given back" sub={usual != null ? `Your usual finish over the last 14 days: ${hhmm(usual)}` : "Your usual finish appears after 3 days of activity."}>
      <div className="tiles">
        <Tile
          label="Last clock-out"
          value={last ? clock(last.finishedAt) : "—"}
          hint={
            !last
              ? "Clock out tonight to start"
              : last.workedAfter
                ? "you kept working after clocking out"
                : last.backMinutes
                  ? `${hm(last.backMinutes)} earlier than your usual ${hhmm(last.usualFinishMinutes!)}`
                  : last.usualFinishMinutes != null
                    ? `your usual finish is ${hhmm(last.usualFinishMinutes)}`
                    : "no usual finish to compare yet"
          }
        />
        <Tile label="Evenings back this week" value={hm(tb.week.backMinutes)} hint={`${tb.week.evenings} ${tb.week.evenings === 1 ? "evening" : "evenings"} clocked out`} />
        <Tile
          label="Agent calls paused"
          value={tb.week.blockedCalls}
          hint={tb.week.lastBlockedAt ? `after hours this week, last at ${clock(tb.week.lastBlockedAt)}` : "after hours this week"}
        />
        <Tile
          label="Late night this week"
          value={hm(tb.lateNight.thisWeek)}
          hint={
            tb.lateNight.lastWeek || tb.lateNight.thisWeek
              ? `${lateDelta <= 0 ? "▼" : "▲"} ${hm(Math.abs(lateDelta))} vs the same days last week`
              : "none this week or last"
          }
        />
      </div>
    </Card>
  );
}

function AgentStatus({ o }: { o: DeveloperOverview }) {
  if (o.agent.length === 0) return null;
  return (
    <Card title="Agent" sub="The collector that reads your Claude Code logs and git history">
      {o.agent.map((a) => (
        <div key={a.id} className="row small">
          <span className="status">
            <span className="dot" style={{ background: a.lastError ? "#d03b3b" : "#0ca30c" }} />
            {a.lastError ? "Error" : "Connected"}
          </span>
          <span>
            {a.name} ({a.isLocal ? "this machine" : "remote"})
          </span>
          <span className="secondary">Last run {ago(a.lastRunAt)}</span>
          {a.lastError && <span className="error-text">{a.lastError}</span>}
        </div>
      ))}
    </Card>
  );
}

function NoAgent({ me, onLinked }: { me: Me; onLinked: () => void }) {
  const [error, setError] = useState("");
  const link = async () => {
    try {
      await api("POST", "/api/me/link-local-agent");
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="banner">
      <div>
        <b>No agent connected to your account.</b>
        <div className="secondary small">
          {me.canLinkLocal
            ? me.localAgent?.linkedTo
              ? `This machine's agent belongs to ${me.localAgent.linkedTo}. Link it to you if this is your machine, or run a remote agent on your own machine.`
              : "Link this machine's agent to read your Claude Code logs and git history."
            : "Run on your own machine: npm run agent -- --server <this server's URL> --user " + me.user.name}
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>
      {me.canLinkLocal && <button className="primary" onClick={link}>Link this machine's agent to me</button>}
    </div>
  );
}

function ManagerView({ me }: { me: Me }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<{ overview: ManagerOverview; detail: DeveloperDetail } | null>(null);
  useEffect(() => {
    api<{ overview: ManagerOverview; detail: DeveloperDetail }>("GET", `/api/me/manager-view?days=${days}`).then(setData);
  }, [days]);
  if (!data) return null;
  const row = data.overview.developers[0];
  return (
    <>
      <div className="spread">
        <div className="notice">
          This is exactly what your manager sees about you: numbers, Jira keys and charts. Never your prompts, code, commit
          messages or tomorrow's list.
        </div>
        <div className="seg">
          {[7, 14, 30].map((d) => (
            <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {row && (
        <div className="tiles">
          <Tile label="Average load" value={row.avgLoad} hint={`last ${days} days`} />
          <Tile label="Hands-on hours" value={row.activeHours} hint={`+ ${row.agentHours} h of Claude working`} />
          <Tile label="Longest stretch" value={hm(row.longestStretchMinutes)} />
          <Tile label="Late-night days" value={row.lateNightDays} />
          <Tile label="Tasks in progress" value={row.tasksInProgress} />
          <Tile label="Tasks done" value={row.tasksDone} hint={`last ${days} days`} />
        </div>
      )}
      <TeamCharts o={data.overview} />
      <DeveloperProgress detail={data.detail} jiraBaseUrl={me.settings.jiraBaseUrl} />
    </>
  );
}

function DevSettings({ me, o, onSaved }: { me: Me; o: DeveloperOverview; onSaved: () => void }) {
  const [emails, setEmails] = useState(o.emails.join(", "));
  const [msg, setMsg] = useState("");
  const save = async () => {
    try {
      await api("PUT", "/api/me/emails", { emails: emails.split(/[,\s]+/).filter(Boolean) });
      setMsg("Saved.");
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  const link = async () => {
    await api("POST", "/api/me/link-local-agent");
    onSaved();
  };
  return (
    <div className="grid-2">
      <WorkdayCard initial={me.workday ?? { mode: "off", endTime: "18:00" }} onSaved={onSaved} />
      <Card title="Git emails" sub="Commits by these emails count as yours, including commits in shared repos on other people's machines.">
        <div className="row">
          <input value={emails} onChange={(e) => setEmails(e.target.value)} style={{ flex: 1 }} placeholder="you@company.com" />
          <button className="primary" onClick={save}>Save</button>
        </div>
        {msg && <div className="small secondary" style={{ marginTop: 8 }}>{msg}</div>}
      </Card>
      <Card title="This machine's agent" sub="Reads Claude Code logs from the machine running Clockout.">
        {me.localAgent?.isMine ? (
          <div>Linked to you.</div>
        ) : (
          <div className="row">
            <span className="secondary">{me.localAgent?.linkedTo ? `Linked to ${me.localAgent.linkedTo}.` : "Not linked yet."}</span>
            {me.canLinkLocal && <button onClick={link}>Link to me</button>}
          </div>
        )}
        <p className="small secondary">
          On another machine, run <code>npm run agent -- --server http://&lt;host&gt;:4321 --user {me.user.name}</code> (the server must be
          started with <code>--lan</code>).
        </p>
      </Card>
    </div>
  );
}

function WorkdayCard({ initial, onSaved }: { initial: Workday; onSaved: () => void }) {
  const [w, setW] = useState(initial);
  const [msg, setMsg] = useState("");
  const save = async (next: Workday) => {
    setW(next);
    try {
      await api("PUT", "/api/me/workday", next);
      setMsg(next.mode === "off" ? "Off." : `Saved. Runs at ${next.endTime} on weekdays while Clockout is running.`);
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  const options: { mode: Workday["mode"]; label: string }[] = [
    { mode: "off", label: "Off" },
    { mode: "wrapup", label: "Write tomorrow's list" },
    { mode: "clockout", label: "Full clock out" },
  ];
  return (
    <Card title="End of workday" sub="Clockout can end the day for you at a set time on weekdays. No notifications, and it skips days you didn't work or already clocked out.">
      <div style={{ display: "grid", gap: 12 }}>
        <div className="seg" role="radiogroup" aria-label="End of workday">
          {options.map((o) => (
            <button key={o.mode} className={w.mode === o.mode ? "on" : ""} onClick={() => save({ ...w, mode: o.mode })}>
              {o.label}
            </button>
          ))}
        </div>
        <label className="row small secondary">
          At
          <input type="time" value={w.endTime} onChange={(e) => e.target.value && save({ ...w, endTime: e.target.value })} />
        </label>
        <div className="small secondary">
          {w.mode === "wrapup" && "Saves open work, writes tomorrow's list and readies tomorrow's pickup. Agents keep running."}
          {w.mode === "clockout" && "Same as pressing Clock out: also pauses Claude Code tools until the next working morning."}
          {w.mode === "off" && "Nothing runs on its own."}
        </div>
        <div className="small muted">Runs while the dashboard is running: keep it open, or use npm run autostart.</div>
        {msg && <div className="small secondary">{msg}</div>}
      </div>
    </Card>
  );
}

// What made up the load score: the biggest parts first, each out of its maximum.
function LoadBreakdown({ parts }: { parts: Day["loadParts"] }) {
  const rows: [string, number, number][] = [
    ["hands-on time", parts.handsOn, 35],
    ["longest stretch", parts.stretch, 20],
    ["parallel sessions", parts.parallel, 15],
    ["late night", parts.lateNight, 15],
    ["context switches", parts.switches, 15],
  ];
  const top = rows.filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]);
  const title = rows.map(([name, p, max]) => `${name}: ${p} of ${max}`).join("\n");
  return (
    <span title={title} style={{ cursor: "help", borderBottom: "1px dotted currentColor" }}>
      {top.length ? `mostly ${top.slice(0, 2).map(([name]) => name).join(" and ")}` : "nothing yet"}
    </span>
  );
}
