// npm run today: your day in the terminal, straight from your Claude Code logs and git.
// Needs no server and no browser; nothing is stored.
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { computeDays, localDateKey, type ActivityEvent, type DayMetrics } from "../server/metrics.js";
import { collect } from "./collect.js";
import { pauseStatus } from "./pause.js";

const hm = (m: number) => {
  const r = Math.round(m);
  return r < 60 ? `${r}m` : `${Math.floor(r / 60)}h ${String(r % 60).padStart(2, "0")}m`;
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const weekday = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export async function todayReport(now = new Date(), color = false): Promise<string> {
  const { payload } = await collect(now);
  const emails = new Set(payload.localEmails);
  const events: ActivityEvent[] = [
    ...payload.claudeEvents.map((e) => ({ ts: Date.parse(e.ts), kind: "claude" as const, sessionId: e.sessionId, repo: e.repo, task: e.task, human: e.human, agent: e.agent })),
    ...payload.commits.filter((c) => emails.has(c.email)).map((c) => ({ ts: Date.parse(c.ts), kind: "git" as const, repo: c.repo, task: c.task, human: true, agent: false })),
  ];
  const { days, tasks } = computeDays(events, DEFAULT_SETTINGS.lateHour);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const todayKey = localDateKey(now.getTime());
  const t = byDate.get(todayKey);

  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const row = (label: string, value: string, note = "") => `  ${label.padEnd(19)}${bold(value)}${note ? `  ${dim(note)}` : ""}`;

  const lines = [bold(`Clockout · ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`), ""];
  const pause = pauseStatus();
  if (pause.paused) lines.push(`  Clocked out until ${pause.untilLabel}. Run npm run resume to unblock Claude Code.`, "");

  if (!t || (t.activeMinutes === 0 && t.agentMinutes === 0)) {
    lines.push("  No prompts or commits from you yet today.");
  } else {
    lines.push(
      row("You, today", hm(t.activeMinutes), t.spanMinutes ? `hands-on, across a ${hm(t.spanMinutes)} day` : ""),
      row("Your agents", hm(t.agentMinutes), t.agentSoloMinutes ? `${hm(t.agentSoloMinutes)} of it on their own` : ""),
      row("Longest stretch", hm(t.longestStretchMinutes), "without a 15-minute break"),
      row("Last break", t.lastBreakAt ? `ended ${clock(t.lastBreakAt)}` : "none yet today"),
      row("Parallel sessions", String(t.peakParallelSessions), "peak at once"),
      row("Context switches", String(t.contextSwitches), `across ${t.reposTouched} ${t.reposTouched === 1 ? "repo" : "repos"}`),
      row("Late night", hm(t.lateNightMinutes)),
      row("Load score", `${t.loadScore} / 100`),
    );
    const todaysTasks = tasks
      .filter((x) => x.date === todayKey && x.task !== "Unassigned" && (x.activeMinutes > 0 || x.agentMinutes > 0))
      .sort((a, b) => b.activeMinutes - a.activeMinutes)
      .slice(0, 5);
    if (todaysTasks.length) {
      lines.push("", `  ${dim("Tasks today")}`);
      for (const x of todaysTasks) lines.push(`  ${x.task.padEnd(12)} ${hm(x.activeMinutes).padStart(7)} you  ${hm(x.agentMinutes).padStart(7)} agents  ${dim(x.repo)}`);
    }
  }

  lines.push("", `  ${dim("Last 7 days         you      agents   finished   load")}`);
  for (let i = 6; i >= 0; i--) {
    const key = localDateKey(now.getTime() - i * 86400000);
    const d: DayMetrics | undefined = byDate.get(key);
    const finish = d?.finishAt ? clock(d.finishAt) : "—";
    const late = d && d.lateNightMinutes > 0 ? dim("  late") : "";
    lines.push(
      `  ${weekday(key).padEnd(16)}${(d && d.activeMinutes ? hm(d.activeMinutes) : "—").padStart(8)}${(d && d.agentMinutes ? hm(d.agentMinutes) : "—").padStart(12)}${finish.padStart(11)}${String(d?.loadScore ?? "—").padStart(7)}${late}`,
    );
  }
  lines.push("", dim(`  From your Claude Code logs and commits by ${[...emails].join(", ") || "your git email"}. Dashboard: npm start`));
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("today.ts")) {
  console.log(await todayReport(new Date(), process.stdout.isTTY));
}
