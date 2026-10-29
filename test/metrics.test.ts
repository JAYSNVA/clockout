import { describe, expect, it } from "vitest";
import { isHumanActivity } from "../agent/claudeLogs";
import { computeDays, loadScore, type ActivityEvent } from "../server/metrics";
import { jiraKeys } from "../shared/jira";
import { todayAt } from "./helpers";

// One event per minute; `every` makes only every nth minute an event.
const run = (start: Date, minutes: number, extra: Partial<ActivityEvent>, every = 1): ActivityEvent[] =>
  Array.from({ length: Math.floor(minutes / every) + 1 }, (_, i) => ({
    ts: start.getTime() + i * every * 60000,
    kind: "claude",
    sessionId: "a",
    repo: "api",
    task: null,
    human: false,
    agent: false,
    ...extra,
  }) as ActivityEvent);
const you = (start: Date, minutes: number, extra: Partial<ActivityEvent> = {}) => run(start, minutes, { human: true, ...extra }, 5);
const claude = (start: Date, minutes: number, extra: Partial<ActivityEvent> = {}) => run(start, minutes, { agent: true, ...extra });
const day = (events: ActivityEvent[]) => computeDays(events, 20);

describe("you vs your agents", () => {
  it("counts your time from your prompts and Claude's time separately", () => {
    // You prompt 09:00-10:00; Claude keeps working until 11:30.
    const { days } = day([...you(todayAt(9), 60), ...claude(todayAt(9), 150)]);
    const d = days[0];
    expect(d.activeMinutes).toBe(60);
    expect(d.longestStretchMinutes).toBe(60);
    expect(d.agentMinutes).toBe(151);
    expect(d.agentSoloMinutes).toBe(90);
    expect(d.blocks).toEqual([{ start: 540, end: 600 }]);
    expect(d.agentBlocks).toEqual([{ start: 540, end: 691 }]);
  });

  it("does not let a long agent run hide your break", () => {
    const { days } = day([...you(todayAt(9), 30), ...claude(todayAt(9), 120), ...you(todayAt(11), 30)]);
    const d = days[0];
    expect(d.activeMinutes).toBe(60);
    expect(d.longestStretchMinutes).toBe(30);
    expect(new Date(d.lastBreakAt!).getHours()).toBe(11);
  });

  it("counts switching between Claude Code sessions as a context switch", () => {
    const events = [
      ...you(todayAt(9), 0, { sessionId: "a" }),
      ...you(todayAt(9, 5), 0, { sessionId: "b" }),
      ...you(todayAt(9, 10), 0, { sessionId: "a" }),
      ...claude(todayAt(9, 1), 12, { sessionId: "b" }), // Claude's output never counts as your switch
    ];
    expect(day(events).days[0].contextSwitches).toBe(2);
  });

  it("measures late night and the evening finish from your activity only", () => {
    const evening = you(todayAt(21), 20);
    const afterMidnight = you(new Date(todayAt(1, 30).getTime() + 86400000), 0);
    const agentNight = claude(todayAt(23), 30);
    const { days } = day([...you(todayAt(9), 30), ...evening, ...agentNight, ...afterMidnight]);
    const today = days[0];
    expect(today.lateNightMinutes).toBe(20);
    expect(new Date(today.finishAt!).getHours()).toBe(1); // 01:30 still belongs to this evening
  });

  it("splits time per task: your minutes and agent minutes", () => {
    const events = [...you(todayAt(9), 60, { task: "PAY-1" }), ...claude(todayAt(9), 90, { task: "PAY-1" }), ...claude(todayAt(14), 30, { task: "PAY-2" })];
    const { tasks } = day(events);
    expect(tasks.find((t) => t.task === "PAY-1")).toMatchObject({ activeMinutes: 60, agentMinutes: 91 });
    expect(tasks.find((t) => t.task === "PAY-2")).toMatchObject({ activeMinutes: 0, agentMinutes: 31 });
  });

  it("handles git-only days and agent-only days", () => {
    const git = day([{ ts: todayAt(14).getTime(), kind: "git", repo: "api", task: "PAY-3", human: true, agent: false }]);
    expect(git.days[0]).toMatchObject({ source: "git-only", activeMinutes: 5, commits: 1 });
    expect(git.tasks[0]).toMatchObject({ task: "PAY-3", commits: 1, activeMinutes: 5 });

    const agentOnly = day(claude(todayAt(2), 60));
    expect(agentOnly.days[0]).toMatchObject({ activeMinutes: 0, longestStretchMinutes: 0, agentMinutes: 61, agentSoloMinutes: 61, lateNightMinutes: 0 });
  });

  it("scores load between 0 and 100", () => {
    expect(loadScore({ activeMinutes: 0, longestStretchMinutes: 0, peakParallelSessions: 0, lateNightMinutes: 0, contextSwitches: 0 })).toBe(0);
    expect(loadScore({ activeMinutes: 900, longestStretchMinutes: 400, peakParallelSessions: 6, lateNightMinutes: 300, contextSwitches: 50 })).toBe(100);
  });
});

describe("isHumanActivity", () => {
  const user = (content: unknown, extra = {}) => ({ type: "user", message: { content }, ...extra });
  it("counts prompts, slash commands and ! commands; not tool results or system messages", () => {
    expect(isHumanActivity(user("fix the tests"))).toBe(true);
    expect(isHumanActivity(user("<command-name>/effort</command-name>"))).toBe(true);
    expect(isHumanActivity(user("<bash-input>ls</bash-input>"))).toBe(true);
    expect(isHumanActivity(user([{ type: "image" }, { type: "text", text: "look" }]))).toBe(true);
    expect(isHumanActivity(user("<local-command-stdout>done</local-command-stdout>"))).toBe(false);
    expect(isHumanActivity(user("<task-notification>agent finished</task-notification>"))).toBe(false);
    expect(isHumanActivity(user([{ type: "tool_result", content: "ok" }]))).toBe(false);
    expect(isHumanActivity(user("Caveat: ...", { isMeta: true }))).toBe(false);
    expect(isHumanActivity({ type: "assistant", message: { content: "hi" } })).toBe(false);
  });
});

describe("jiraKeys", () => {
  it("finds keys and ignores look-alikes", () => {
    expect(jiraKeys("PAY-142: fix UTF-8 and SHA-256 in feature/AB12-7")).toEqual(["PAY-142", "AB12-7"]);
    expect(jiraKeys("lowercase pay-1")).toEqual([]);
  });
});
