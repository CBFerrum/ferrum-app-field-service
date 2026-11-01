import { describe, expect, it } from "vitest";
import { billed, costs, elapsed, fitWithin, gaps, history, hoursText, isImage, margin, progress, serialNote, serials, steps, stopped, toggled } from "./job";

const task = (id: string, done: boolean, required = true) => ({ id, task: id, required, done });

describe("the checklist", () => {
  it("counts what is done and what must be", () => {
    expect(progress([task("a", true), task("b", false), task("c", false, false), task("d", true, false)])).toEqual({ done: 2, total: 4, required: 2, requiredLeft: 1 });
    expect(progress([])).toEqual({ done: 0, total: 0, required: 0, requiredLeft: 0 });
  });

  it("ticks one task and leaves the others", () => {
    const rows = [task("a", false), task("b", false)];
    expect(toggled(rows, "b", true).map((r) => r.done)).toEqual([false, true]);
    expect(rows[1].done).toBe(false);
  });
});

describe("what stands between a job and its completion", () => {
  const rules = { require_checklist: true, require_signature: true };

  it("names each thing the server will ask for, and where to put it right", () => {
    expect(gaps({ checklist: [task("a", false), task("b", false)] }, rules)).toEqual([
      { text: "2 required tasks are not done", section: "checklist" },
      { text: "The customer has not signed", section: "signoff" },
      { text: "Who signed is not written down", section: "signoff" },
    ]);
    expect(gaps({ checklist: [task("a", false)], customer_signature: "/files/1", signed_by: "Pat" }, rules)).toEqual([{ text: "1 required task is not done", section: "checklist" }]);
  });

  it("asks for nothing the settings switched off", () => {
    expect(gaps({ checklist: [task("a", false)] }, { require_checklist: false, require_signature: false })).toEqual([]);
  });

  it("is ready when everything is in", () => {
    expect(gaps({ checklist: [task("a", true)], customer_signature: "/files/1", signed_by: " Pat " }, rules)).toEqual([]);
    expect(gaps({ checklist: [], customer_signature: "/files/1", signed_by: "   " }, rules)).toEqual([{ text: "Who signed is not written down", section: "signoff" }]);
  });
});

describe("where a job is on its way", () => {
  it("marks the steps before it done and the ones after it to come", () => {
    const { steps: s, cancelled } = steps("En Route");
    expect(cancelled).toBe(false);
    expect(s.map((x) => x.state)).toEqual(["done", "done", "done", "current", "todo", "todo", "todo"]);
  });

  it("shows a cancelled job as stopped, with none of the steps reached", () => {
    const { steps: s, cancelled } = steps("Cancelled");
    expect(cancelled).toBe(true);
    expect(s.every((x) => x.state === "todo")).toBe(true);
  });
});

describe("parts and time", () => {
  it("counts serial numbers, one a line", () => {
    expect(serials("A1\n  B2 \n\nC3")).toEqual(["A1", "B2", "C3"]);
    expect(serials(null)).toEqual([]);
    expect(serialNote("A1\nB2", "3")).toBe("2 of 3 serial numbers given");
    expect(serialNote("A1", 1)).toBeNull();
    expect(serialNote("", "1")).toBe("0 of 1 serial number given");
    expect(serialNote("A1", "nope")).toBeNull();
  });

  it("writes hours the way people say them", () => {
    expect([hoursText("1.50"), hoursText(8), hoursText("0.333"), hoursText(null), hoursText("x")]).toEqual(["1.5", "8", "0.33", "0", "0"]);
  });

  it("shows a running timer as hours, minutes and seconds", () => {
    expect(elapsed(0, 83_000)).toBe("0:01:23");
    expect(elapsed(0, 3_723_000)).toBe("1:02:03");
    expect(elapsed(5000, 1000)).toBe("0:00:00");
  });

  it("records the time a timer ran, unless it ran under a second", () => {
    expect(stopped(Date.parse("2026-11-02T09:00:00Z"), Date.parse("2026-11-02T10:30:00Z"))).toEqual({ from: "2026-11-02T09:00:00.000Z", to: "2026-11-02T10:30:00.000Z" });
    expect(stopped(1000, 1500)).toBeNull();
  });

  it("makes a photo smaller without enlarging a small one", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(isImage("IMG_001.JPG")).toBe(true);
    expect(isImage("notes.pdf")).toBe(false);
    expect(isImage(null)).toBe(false);
  });
});

describe("cost against billable", () => {
  it("adds up what it cost, for those who may see costs", () => {
    expect(costs({ labour_cost: "45.10", parts_cost: "31", expense_total: "32.5" })).toEqual({ labour: "45.10", parts: "31", expenses: "32.5", cost: "108.60" });
  });

  it("shows no cost to those who may not", () => {
    expect(costs({ expense_total: "12" })).toEqual({ labour: null, parts: null, expenses: "12", cost: null });
    expect(costs({})).toMatchObject({ cost: null, expenses: "0" });
  });

  it("sets the bill against the cost, exactly", () => {
    expect(margin("150.00", "108.60")).toBe("41.40");
    expect(margin("50", "108.6")).toBe("-58.6");
    expect(margin("50", null)).toBeNull();
    expect(margin(undefined, "5")).toBeNull();
  });

  it("reads an invoice's lines, those covered by warranty or contract marked", () => {
    const lines = billed([
      { description: "Filter — replaced under warranty", qty: "2", price_list_rate: "8", discount_percent: "100", amount: "0" },
      { item_name: "Labour", description: "", qty: "1.5", rate: "80", discount_percent: "0", amount: "120" },
    ]);
    expect(lines.map((l) => [l.text, l.free, l.amount])).toEqual([
      ["Filter — replaced under warranty", true, "0"],
      ["Labour", false, "120"],
    ]);
    expect(lines[0].rate).toBe("8");
  });
});

describe("what happened to a job", () => {
  it("tells it from the moments stamped on it, oldest first, leaving out what has not happened", () => {
    const events = history({ completed_at: "2026-11-02T11:00:00Z", reported_at: "2026-11-02T08:00:00Z", arrived_at: "2026-11-02T09:30:00Z", signed_at: "2026-11-02T10:55:00Z", signed_by: "Pat Morgan" });
    expect(events.map((e) => e.text)).toEqual(["Problem reported", "Technician arrived on site", "Signed by Pat Morgan", "Job completed"]);
    expect(history({})).toEqual([]);
  });
});
