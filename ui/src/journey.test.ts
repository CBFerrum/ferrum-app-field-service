import { describe, expect, it } from "vitest";
import type { Board, Visit } from "./board";
import { arrange, changes, type Details, directionsUrl, laneOf, nextStep, rescheduled, seen, telUrl, waiting } from "./journey";

const visit = (n: string, from: string, to: string, status = "Dispatched"): Visit => ({
  appointment: `a${n}`,
  number: `FSA-${n}`,
  status,
  start: `2026-11-02T${from}:00.000Z`,
  end: `2026-11-02T${to}:00.000Z`,
  actual_start: null,
  actual_end: null,
  work_order: `w${n}`,
  work_order_number: `FSWO-${n}`,
  customer_name: `Customer ${n}`,
  priority: null,
  site: null,
  travel: null,
});

describe("a technician's day", () => {
  const details = new Map<string, Details>([["w1", { id: "w1", customer_name: "Acme" }]]);

  it("puts the visits in order and picks the one to do next", () => {
    const day = arrange([visit("2", "13:00", "14:00"), visit("1", "09:00", "10:00"), visit("3", "15:00", "16:00")], details);
    expect(day.now).toBeNull();
    expect(day.next?.visit.appointment).toBe("a1");
    expect(day.next?.job?.customer_name).toBe("Acme");
    expect(day.later.map((s) => s.visit.appointment)).toEqual(["a2", "a3"]);
  });

  it("puts the job under way first, and the rest behind it", () => {
    const day = arrange([visit("1", "09:00", "10:00", "Completed"), visit("2", "10:30", "11:30", "On Site"), visit("3", "13:00", "14:00")], details);
    expect(day.now?.visit.appointment).toBe("a2");
    expect(day.next).toBeNull();
    expect(day.later.map((s) => s.visit.appointment)).toEqual(["a3"]);
    expect(day.done.map((s) => s.visit.appointment)).toEqual(["a1"]);
  });

  it("leaves out what was cancelled and has no next when everything is done", () => {
    const day = arrange([visit("1", "09:00", "10:00", "Cancelled"), visit("2", "10:00", "11:00", "Completed")], details);
    expect([day.now, day.next, day.later.length, day.done.length]).toEqual([null, null, 0, 1]);
  });

  it("finds a person's own lane by their email address", () => {
    const board = { technicians: [{ user_email: "Asha@x.test", technician: "a" }, { user_email: null, technician: "b" }] } as unknown as Board;
    expect(laneOf(board, " asha@X.test ")?.technician).toBe("a");
    expect(laneOf(board, "nobody@x.test")).toBeUndefined();
    expect(laneOf(board, undefined)).toBeUndefined();
  });
});

describe("what to do next on a job", () => {
  it("is the one legal step", () => {
    expect(nextStep("Dispatched")).toEqual({ action: "start_travel", label: "Start travel" });
    expect(nextStep("En Route")?.action).toBe("arrive");
    expect(nextStep("On Site")?.action).toBe("complete");
  });

  it("is nothing before dispatch or after completion, and says why", () => {
    for (const s of ["New", "Scheduled", "Completed", "Invoiced", "Cancelled", undefined]) expect(nextStep(s)).toBeNull();
    expect(waiting("Scheduled")).toMatch(/dispatcher/);
    expect(waiting("Cancelled")).toMatch(/cancelled/);
    expect(waiting("On Site")).toBeNull();
  });
});

describe("getting there", () => {
  it("links to directions by coordinates, else by address, else not at all", () => {
    expect(directionsUrl({ latitude: "51.5", longitude: "-0.12", site_address: "1 High St" })).toBe("https://www.google.com/maps/dir/?api=1&destination=51.5%2C-0.12");
    expect(directionsUrl({ site_address: "1 High St\nLeeds" })).toBe("https://www.google.com/maps/dir/?api=1&destination=1%20High%20St%20Leeds");
    expect(directionsUrl({})).toBeNull();
    expect(directionsUrl(undefined)).toBeNull();
  });

  it("makes a phone number a link only when it is one", () => {
    expect(telUrl("+44 (0)7700 900123")).toBe("tel:+4407700900123");
    expect(telUrl("n/a")).toBeNull();
    expect(telUrl(null)).toBeNull();
  });
});

describe("what the dispatcher changed meanwhile", () => {
  const before = seen([visit("1", "09:00", "10:00"), visit("2", "13:00", "14:00"), visit("3", "15:00", "16:00", "Dispatched")]);

  it("says what moved, what went and what came", () => {
    const after = seen([visit("1", "09:30", "10:30"), visit("3", "15:00", "16:00", "Scheduled"), visit("4", "17:00", "18:00")]);
    expect(changes(before, after, "UTC")).toEqual([
      expect.stringContaining("FSWO-1 moved to"),
      "FSWO-2 is no longer on your day.",
      "FSWO-3 is waiting to be dispatched again.",
      expect.stringContaining("FSWO-4 was added to your day"),
    ]);
  });

  it("says nothing when the technician's own progress is all that changed", () => {
    const after = seen([visit("1", "09:00", "10:00", "En Route"), visit("2", "13:00", "14:00"), visit("3", "15:00", "16:00")]);
    expect(changes(before, after, "UTC")).toEqual([]);
  });

  it("does not report a finished visit as taken away", () => {
    const done = seen([visit("1", "09:00", "10:00", "Completed")]);
    expect(changes(done, [], "UTC")).toEqual([]);
  });
});

describe("a job moved while it is open", () => {
  const was = { scheduled_start: "2026-11-02T09:00:00.000Z", scheduled_end: "2026-11-02T10:00:00.000Z" };

  it("says where it went", () => {
    expect(rescheduled(was, { scheduled_start: "2026-11-02T13:00:00.000Z", scheduled_end: "2026-11-02T14:30:00.000Z" }, "UTC")).toMatch(/^The dispatcher moved this job to .*, .*1:00.*–.*2:30/);
  });

  it("says when it was taken off the schedule", () => {
    expect(rescheduled(was, { scheduled_start: null, scheduled_end: null }, "UTC")).toBe("The dispatcher took this job off the schedule.");
  });

  it("says nothing when its time is the same, or it was not known before", () => {
    expect(rescheduled(was, { ...was }, "UTC")).toBeNull();
    expect(rescheduled(undefined, was, "UTC")).toBeNull();
  });
});
