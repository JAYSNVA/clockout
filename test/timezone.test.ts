import { describe, expect, it } from "vitest";
import { openDb, run } from "../server/db";
import { computeDays, localDateKey, wallClock, type ActivityEvent } from "../server/metrics";
import { runSchedule } from "../server/scheduler";
import { createDeveloper, ensureLocalDevice, ingestPayload, jobById, linkLocalDevice, setWorkday, timeZoneOf } from "../server/store";

const at = (iso: string): ActivityEvent => ({ ts: Date.parse(iso), kind: "claude", sessionId: "s", repo: "api", task: null, human: true, agent: false });
const evening = ["2026-10-28T23:30:00Z", "2026-10-28T23:40:00Z", "2026-10-28T23:50:00Z"].map(at);

describe("time zones", () => {
  it("converts instants to each developer's wall clock", () => {
    expect(wallClock(Date.parse("2026-10-28T23:30:00Z"), "America/New_York")).toMatchObject({ hours: 19, minutes: 30, day: 28 });
    expect(wallClock(Date.parse("2026-10-28T23:30:00Z"), "Asia/Tokyo")).toMatchObject({ hours: 8, minutes: 30, day: 29 });
    expect(localDateKey(Date.parse("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01"); // 00:30 EST after the DST change
  });

  it("computes days and late night in the developer's zone, not the server's", () => {
    const ny = computeDays(evening, 20, "America/New_York").days[0];
    expect(ny).toMatchObject({ date: "2026-10-28", lateNightMinutes: 0 }); // 19:30-19:50 in New York
    const tokyo = computeDays(evening, 20, "Asia/Tokyo").days[0];
    expect(tokyo.date).toBe("2026-10-29"); // 08:30 next morning in Tokyo
    const berlin = computeDays(evening, 20, "Europe/Berlin").days[0];
    expect(berlin.lateNightMinutes).toBe(20); // 00:30-00:50 in Berlin
    expect(berlin.date).toBe("2026-10-29");
  });

  it("stores the zone the agent reports and runs the schedule on the developer's clock", () => {
    const db = openDb(":memory:");
    const ny = createDeveloper(db, "Nia", []);
    const dub = createDeveloper(db, "Dan", []);
    ensureLocalDevice(db, "laptop");
    linkLocalDevice(db, ny.id);
    run(db, "INSERT INTO devices (user_id, name, token_hash) VALUES (?, 'dan-laptop', 'x')", dub.id);
    const payload = { deviceName: "x", collectedAt: "", localEmails: [], claudeEvents: [], commits: [], tasks: [], blockedCalls: [] };
    ingestPayload(db, ny.id, { ...payload, timeZone: "America/New_York" });
    ingestPayload(db, dub.id, { ...payload, timeZone: "Europe/Dublin" });
    ingestPayload(db, dub.id, { ...payload, timeZone: "Not/AZone" }); // ignored
    expect(timeZoneOf(db, ny.id)).toBe("America/New_York");
    expect(timeZoneOf(db, dub.id)).toBe("Europe/Dublin");

    setWorkday(db, ny.id, { mode: "wrapup", endTime: "18:00" });
    setWorkday(db, dub.id, { mode: "wrapup", endTime: "18:00" });
    // 22:05 UTC = 18:05 in New York (due), 22:05 in Dublin (more than 3 hours late: skipped)
    const ids = runSchedule(db, new Date("2026-10-28T22:05:00Z"));
    expect(ids.map((id) => jobById(db, id)!.user_id)).toEqual([ny.id]);
  });
});
