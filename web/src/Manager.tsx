import { useCallback, useEffect, useState } from "react";
import { api, type DeveloperDetail, type ManagerOverview, type Me, type Settings } from "./api";
import { devColor } from "./charts";
import { Card, DeveloperProgress, TeamCharts, Tile } from "./components";
import { ago, hm } from "./format";

type Tab = "overview" | "people" | "settings";

export function ManagerPage({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState(14);
  const [userId, setUserId] = useState<number | "">("");
  const [o, setO] = useState<ManagerOverview | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setO(await api<ManagerOverview>("GET", `/api/manager/overview?days=${days}${userId ? `&userId=${userId}` : ""}`));
  }, [days, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!o) return null;
  const k = o.kpis;

  return (
    <main className="page">
      <div className="spread">
        <div>
          <div className="eyebrow">Team view</div>
          <h1>Progress, and the load behind it.</h1>
        </div>
      </div>

      <nav className="tabs">
        <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
        <button className={tab === "people" ? "on" : ""} onClick={() => setTab("people")}>People</button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Settings</button>
      </nav>

      {tab === "overview" && (
        <>
          <div className="row">
            <div className="seg">
              {[7, 14, 30].map((d) => (
                <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
                  {d} days
                </button>
              ))}
            </div>
            <select value={userId} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">All developers</option>
              {o.allDevelopers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          {o.allDevelopers.length === 0 ? (
            <div className="notice">
              No developers yet. Developers appear when they sign in, or add them under <b>People</b> by git email to include
              their commits from shared repos.
            </div>
          ) : !o.hasData ? (
            <div className="notice">No activity collected yet. Developers press <b>Collect now</b> on their dashboard.</div>
          ) : null}

          <div className="tiles">
            <Tile label="Tasks done this week" value={k.tasksDoneThisWeek} />
            <Tile label="Median cycle time" value={k.medianCycleDays != null ? `${k.medianCycleDays} d` : "—"} hint={`tasks finished in last ${days} days`} />
            <Tile label="Hands-on hours" value={k.activeHours} hint={`+ ${k.agentHours} h of Claude working, last ${days} days`} />
            <Tile label="Over load threshold" value={`${k.overloaded} / ${k.developers}`} hint={`7-day average load ≥ ${k.loadThreshold}`} />
          </div>

          <Card title="Developers" sub="Select a row for tasks and weekly progress">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Developer</th>
                    <th className="num">Load (7 d)</th>
                    <th className="num">Avg load</th>
                    <th className="num">Hands-on h</th>
                    <th className="num">Agent h</th>
                    <th className="num">Longest stretch</th>
                    <th className="num">Late-night days</th>
                    <th className="num">In progress</th>
                    <th className="num">Done</th>
                  </tr>
                </thead>
                <tbody>
                  {o.developers.map((d) => (
                    <tr key={d.id} className={`clickable${selected === d.id ? " selected" : ""}`} onClick={() => setSelected(selected === d.id ? null : d.id)}>
                      <td>
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 8, background: devColor(d.name, o.allDevelopers) }} />
                        {d.name}
                        {d.gitOnly && <span className="muted small"> · git-only</span>}
                        {!d.hasData && <span className="muted small"> · no data</span>}
                      </td>
                      <td className="num">
                        {d.load7 >= k.loadThreshold ? <span title="Over threshold" style={{ color: "#d03b3b" }}>▲ {d.load7}</span> : d.load7}
                      </td>
                      <td className="num">{d.avgLoad}</td>
                      <td className="num">{d.activeHours}</td>
                      <td className="num">{d.agentHours}</td>
                      <td className="num">{hm(d.longestStretchMinutes)}</td>
                      <td className="num">{d.lateNightDays}</td>
                      <td className="num">{d.tasksInProgress}</td>
                      <td className="num">{d.tasksDone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {selected && <DeveloperPanel id={selected} jiraBaseUrl={o.settings.jiraBaseUrl} />}
          <TeamCharts o={o} />
        </>
      )}

      {tab === "people" && <People onChanged={load} />}
      {tab === "settings" && <ManagerSettings initial={o.settings} onSaved={load} me={me} />}
    </main>
  );
}

function DeveloperPanel({ id, jiraBaseUrl }: { id: number; jiraBaseUrl: string }) {
  const [data, setData] = useState<({ developer: { name: string; emails: string[] } } & DeveloperDetail) | null>(null);
  useEffect(() => {
    api<{ developer: { name: string; emails: string[] } } & DeveloperDetail>("GET", `/api/manager/developers/${id}`).then(setData);
  }, [id]);
  if (!data) return null;
  return (
    <>
      <h2>{data.developer.name}</h2>
      <DeveloperProgress detail={data} jiraBaseUrl={jiraBaseUrl} />
    </>
  );
}

interface PeopleData {
  developers: { id: number; name: string; emails: string[] }[];
  unmatched: { email: string; name: string; commits: number; last_ts: string }[];
}

function People({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<PeopleData | null>(null);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");

  const load = useCallback(async () => setData(await api<PeopleData>("GET", "/api/manager/people")), []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) return null;
  return (
    <>
      {error && <div className="banner error">{error}</div>}
      <Card title="Developers" sub="Git emails decide whose commits are whose">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Git emails</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.developers.map((d) => (
              <DeveloperRow
                key={d.id}
                d={d}
                onSave={(name, emails) => act(() => api("PATCH", `/api/manager/developers/${d.id}`, { name, emails }))}
                onDelete={() => {
                  if (confirm(`Remove ${d.name} and all their collected data?`)) void act(() => api("DELETE", `/api/manager/developers/${d.id}`));
                }}
              />
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 16 }}>
          <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input placeholder="git email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} style={{ minWidth: 240 }} />
          <button
            className="primary"
            disabled={!newName.trim()}
            onClick={() =>
              act(async () => {
                await api("POST", "/api/manager/developers", { name: newName, emails: newEmail ? [newEmail] : [] });
                setNewName("");
                setNewEmail("");
              })
            }
          >
            Add developer
          </button>
        </div>
      </Card>

      <Card title="Unmatched authors" sub="Commit authors in collected repos who are not linked to a developer yet">
        {data.unmatched.length === 0 ? (
          <div className="empty">Every commit author is matched.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Author</th>
                <th>Email</th>
                <th className="num">Commits</th>
                <th>Last commit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.unmatched.map((u) => (
                <tr key={u.email}>
                  <td>{u.name}</td>
                  <td className="secondary">{u.email}</td>
                  <td className="num">{u.commits}</td>
                  <td className="secondary">{ago(u.last_ts)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => act(() => api("POST", "/api/manager/developers", { name: u.name || u.email, emails: [u.email] }))}>
                      Create developer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function DeveloperRow({ d, onSave, onDelete }: { d: PeopleData["developers"][number]; onSave: (name: string, emails: string[]) => void; onDelete: () => void }) {
  const [name, setName] = useState(d.name);
  const [emails, setEmails] = useState(d.emails.join(", "));
  const dirty = name !== d.name || emails !== d.emails.join(", ");
  return (
    <tr>
      <td>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>
        <input value={emails} onChange={(e) => setEmails(e.target.value)} style={{ width: "100%" }} placeholder="no emails yet" />
      </td>
      <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
        <button disabled={!dirty} onClick={() => onSave(name, emails.split(/[,\s]+/).filter(Boolean))}>
          Save
        </button>{" "}
        <button className="danger" onClick={onDelete}>
          Remove
        </button>
      </td>
    </tr>
  );
}

function ManagerSettings({ initial, onSaved }: { initial: Settings; onSaved: () => void; me: Me }) {
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState("");
  const save = async () => {
    try {
      await api("PUT", "/api/manager/settings", s);
      setMsg("Saved. Metrics recalculated.");
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  const field = (label: string, key: keyof Settings, type: "text" | "number", hint: string) => (
    <label style={{ display: "grid", gap: 4 }}>
      <span>{label}</span>
      <input type={type} value={s[key]} onChange={(e) => setS({ ...s, [key]: type === "number" ? Number(e.target.value) : e.target.value })} />
      <span className="small muted">{hint}</span>
    </label>
  );
  return (
    <Card title="Settings" sub="Apply to everyone">
      <div style={{ display: "grid", gap: 16, maxWidth: 480 }}>
        {field("Jira base URL", "jiraBaseUrl", "text", "e.g. https://acme.atlassian.net — turns task keys into links. No API calls are made.")}
        {field("Late-night hour", "lateHour", "number", "Work after this hour (or before 06:00) counts as late night.")}
        {field("Resume hour", "resumeHour", "number", "Clock out pauses agents until this hour on the next workday.")}
        {field("Load threshold", "loadThreshold", "number", "7-day average load at or above this counts as overloaded.")}
        <div className="row">
          <button className="primary" onClick={save}>Save</button>
          {msg && <span className="small secondary">{msg}</span>}
        </div>
      </div>
    </Card>
  );
}
