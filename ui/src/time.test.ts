import { describe, expect, it } from "vitest";
import { addDays, dayOf, daysBetween, fromWallInput, instantOf, isDay, knownZone, offsetMs, snap, span, wall, wallInput, weekStart } from "./time";

const at = (iso: string) => Date.parse(iso);

describe("time in a zone", () => {
  it("reads an instant as the zone's wall clock", () => {
    expect(wall(at("2026-11-02T04:30:00Z"), "Asia/Kolkata")).toMatchObject({ year: 2026, month: 11, day: 2, hour: 10, minute: 0 });
    expect(dayOf(at("2026-11-02T20:00:00Z"), "Asia/Kolkata")).toBe("2026-11-03");
    expect(dayOf(at("2026-11-02T20:00:00Z"), "America/New_York")).toBe("2026-11-02");
    // Midnight is hour 0, never 24.
    expect(wall(at("2026-11-02T00:00:00Z"), "UTC").hour).toBe(0);
  });

  it("builds the instant of a wall time, as the server does at the clock changes", () => {
    expect(new Date(instantOf("2026-11-02", 9 * 60, "Asia/Kolkata")).toISOString()).toBe("2026-11-02T03:30:00.000Z");
    // London: Saturday 24 October is summer time, Sunday 25 October is not.
    expect(new Date(instantOf("2026-10-24", 9 * 60, "Europe/London")).toISOString()).toBe("2026-10-24T08:00:00.000Z");
    expect(new Date(instantOf("2026-10-25", 9 * 60, "Europe/London")).toISOString()).toBe("2026-10-25T09:00:00.000Z");
    // 01:30 on 25 October happens twice: the first (summer time) is taken.
    expect(new Date(instantOf("2026-10-25", 90, "Europe/London")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    // 01:30 on 29 March does not exist: it is the instant it would have been before the clocks moved.
    expect(new Date(instantOf("2026-03-29", 90, "Europe/London")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // Minutes past the day's end roll into the next day (the end of a day is the next midnight).
    expect(instantOf("2026-11-02", 1440, "UTC")).toBe(instantOf("2026-11-03", 0, "UTC"));
  });

  it("knows a day is 25 hours long when the clocks go back", () => {
    const hours = (instantOf("2026-10-26", 0, "Europe/London") - instantOf("2026-10-25", 0, "Europe/London")) / 3_600_000;
    expect(hours).toBe(25);
    expect(offsetMs(at("2026-07-01T12:00:00Z"), "Europe/London")).toBe(3_600_000);
  });

  it("round-trips the value of a datetime-local field", () => {
    const ms = at("2026-11-02T03:30:00Z");
    expect(wallInput(ms, "Asia/Kolkata")).toBe("2026-11-02T09:00");
    expect(fromWallInput("2026-11-02T09:00", "Asia/Kolkata")).toBe(ms);
    expect(fromWallInput("", "UTC")).toBeNull();
    expect(fromWallInput("2026-13-40T09:00", "UTC")).toBeNull();
    expect(fromWallInput("2026-11-02T24:00", "UTC")).toBeNull();
  });

  it("falls back from a zone the browser does not know", () => {
    expect(knownZone("Not/AZone", "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(knownZone(null, "nonsense")).toBe("UTC");
    expect(knownZone("Europe/London")).toBe("Europe/London");
  });
});

describe("days", () => {
  it("counts and moves dates", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-11-01", "2026-11-08")).toBe(7);
    expect(weekStart("2026-11-01")).toBe("2026-10-26"); // a Sunday belongs to the week before
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
    expect(weekStart("2026-11-05")).toBe("2026-11-02");
  });

  it("accepts only real dates", () => {
    expect(isDay("2026-11-02")).toBe(true);
    for (const bad of ["", "2026-11-31", "11/02/2026", "2026-02-30", "2026-2-3", null, undefined]) expect(isDay(bad as string)).toBe(false);
  });
});

describe("lengths of time", () => {
  it("says them as people do", () => {
    expect(span(25 * 60_000)).toBe("25 min");
    expect(span(90 * 60_000)).toBe("1 h 30 min");
    expect(span(3 * 3_600_000)).toBe("3 h");
    expect(span(72 * 3_600_000)).toBe("3 days");
    expect(span(-5)).toBe("0 min");
  });

  it("snaps to the quarter hour", () => {
    expect([snap(7), snap(8), snap(22), snap(67)]).toEqual([0, 15, 15, 60]);
  });
});
