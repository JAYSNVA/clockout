import type { ReactNode } from "react";
import type { DeveloperDetail, ManagerOverview, TaskStatus } from "./api";
import { CycleTimeLine, FlowSankey, HoursPie, LoadLines, LoadOutputScatter, OTHER, SERIES, STATUS_COLOR, WeeklyDoneBars, WeeklyProgressBars, devColor } from "./charts";
import { ago, hm, weekLabel } from "./format";

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Card({ title, sub, children, right }: { title: string; sub?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card">
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <h3>{title}</h3>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

const STATUS_ICON: Record<TaskStatus, string> = { Done: "✓", "In progress": "→", Stalled: "!" };

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className="status">
      <span className="dot" style={{ background: STATUS_COLOR[status] }} />
      <span aria-hidden>{STATUS_ICON[status]}</span> {status}
    </span>
  );
}

export function TaskKey({ k, jiraBaseUrl }: { k: string; jiraBaseUrl: string }) {
  if (!jiraBaseUrl) return <code>{k}</code>;
  return (
    <a href={`${jiraBaseUrl}/browse/${k}`} target="_blank" rel="noreferrer">
      <code>{k}</code>
    </a>
  );
}

export function TaskTable({ tasks, jiraBaseUrl }: { tasks: DeveloperDetail["tasks"]; jiraBaseUrl: string }) {
  if (tasks.length === 0) {
    return <div className="empty">No Jira keys found yet. Put keys like PAY-142 in branch names, commit messages or Claude prompts.</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Repo</th>
            <th className="num">Hands-on h</th>
            <th className="num">Agent h</th>
            <th className="num">Commits</th>
            <th className="num">Cycle time</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.key}>
              <td><TaskKey k={t.key} jiraBaseUrl={jiraBaseUrl} /></td>
              <td><StatusBadge status={t.status} /></td>
              <td className="secondary">{t.repos.join(", ")}</td>
              <td className="num">{t.hours}</td>
              <td className="num">{t.agentHours || "—"}</td>
              <td className="num">{t.commits}</td>
              <td className="num">{t.cycleDays != null ? `${t.cycleDays} d` : "—"}</td>
              <td className="secondary">{ago(t.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WeeklyTable({ weekly }: { weekly: DeveloperDetail["weekly"] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Week of</th>
          <th className="num">Tasks done</th>
          <th className="num">Hands-on h</th>
          <th className="num">Agent h</th>
          <th className="num">Avg load</th>
          <th className="num">Late-night</th>
        </tr>
      </thead>
      <tbody>
        {weekly.map((w) => (
          <tr key={w.week}>
            <td>{weekLabel(w.week)}</td>
            <td className="num">{w.tasksDone}</td>
            <td className="num">{w.activeHours}</td>
            <td className="num">{w.agentHours}</td>
            <td className="num">{w.avgLoad}</td>
            <td className="num">{w.lateNightMinutes ? hm(w.lateNightMinutes) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Charts shared by the manager dashboard and a developer's "What my manager sees" tab.
export function TeamCharts({ o }: { o: ManagerOverview }) {
  const devNames = o.developers.map((d) => d.name);
  const all = o.allDevelopers;
  return (
    <>
      <div className="grid-2">
        <Card title="Where the time went" sub={`Hands-on hours per Jira task, last ${o.rangeDays} days`}>
          <HoursPie data={o.pieByTask} colorFor={(name, i) => (name === "Other tasks" || name === "Unassigned" ? OTHER : SERIES[i % SERIES.length])} />
        </Card>
        <Card title="Who carried it" sub={`Hands-on hours per developer, last ${o.rangeDays} days`}>
          <HoursPie data={o.pieByDeveloper} colorFor={(name) => devColor(name, all)} />
        </Card>
      </div>
      <Card title="Developer → task → status" sub="Width is hands-on hours. Shows where effort went and whether it finished.">
        <FlowSankey data={o.sankey} devs={all} />
      </Card>
      <div className="grid-2">
        <Card title="Tasks done per week" sub="Finished = merged to the default branch. Last 6 weeks.">
          <WeeklyDoneBars data={o.weeklyDone} devs={devNames} all={all} />
        </Card>
        <Card title="Load score" sub={`Daily load 0–100, last ${o.rangeDays} days`}>
          <LoadLines data={o.loadTrend} devs={devNames} all={all} threshold={o.kpis.loadThreshold} />
        </Card>
      </div>
      <div className="grid-2">
        <Card title="Load vs output" sub="One dot per developer per week. Dots far right but not higher mean more hours without more done — the burnout signal.">
          <LoadOutputScatter data={o.scatter} />
        </Card>
        <Card title="Cycle time" sub="Median days from first activity to merge, per week. Lower is better.">
          <CycleTimeLine data={o.cycleTrend} />
        </Card>
      </div>
    </>
  );
}

export function DeveloperProgress({ detail, jiraBaseUrl }: { detail: DeveloperDetail; jiraBaseUrl: string }) {
  return (
    <div className="grid-2">
      <Card title="Weekly progress" sub="Tasks finished per week, with the load behind them">
        <WeeklyProgressBars data={detail.weekly} />
        <WeeklyTable weekly={detail.weekly} />
      </Card>
      <Card title="Tasks" sub="Every Jira task this developer worked on">
        <TaskTable tasks={detail.tasks} jiraBaseUrl={jiraBaseUrl} />
      </Card>
    </div>
  );
}

// Minimal markdown for tomorrow's list: headings, bullets, bold, inline code.
export function Markdown({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : part,
    );
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={out.length}>{list}</ul>);
    list = [];
  };
  text.split("\n").forEach((line, i) => {
    if (/^\s*- /.test(line)) {
      const nested = /^\s{2,}- /.test(line);
      list.push(<li key={i} style={nested ? { marginLeft: 18, listStyle: "circle" } : undefined}>{inline(line.replace(/^\s*- /, ""))}</li>);
      return;
    }
    flush();
    if (line.startsWith("# ")) out.push(<h1 key={i}>{inline(line.slice(2))}</h1>);
    else if (line.startsWith("## ")) out.push(<h2 key={i}>{inline(line.slice(3))}</h2>);
    else if (line.trim()) out.push(<p key={i}>{inline(line)}</p>);
  });
  flush();
  return <div className="md">{out}</div>;
}
