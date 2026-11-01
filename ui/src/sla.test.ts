import { describe, expect, it } from "vitest";
import { slaChip, slaClocks } from "./sla";

const at = (iso: string) => Date.parse(iso);
const now = at("2026-11-02T10:00:00Z");

describe("the service-level chip", () => {
  it("says nothing for a job with no target", () => {
    expect(slaChip({ sla_status: null }, now, "UTC")).toBeNull();
    expect(slaChip({}, now, "UTC")).toBeNull();
  });

  it("counts down the response while nobody has arrived", () => {
    const chip = slaChip({ sla_status: "At Risk", response_due: "2026-11-02T10:40:00Z", resolution_due: "2026-11-03T08:00:00Z" }, now, "UTC");
    expect(chip).toMatchObject({ tone: "amber", text: "Arrive within 40 min" });
    expect(chip?.title).toContain("Response due");
  });

  it("counts down the resolution once someone is on site", () => {
    const chip = slaChip(
      { sla_status: "At Risk", arrived_at: "2026-11-02T09:00:00Z", response_due: "2026-11-02T12:00:00Z", resolution_due: "2026-11-02T12:30:00Z" },
      now,
      "UTC",
    );
    expect(chip).toMatchObject({ tone: "amber", text: "Finish within 2 h 30 min" });
    expect(chip?.title).toContain("Resolution due");
  });

  it("says how long a missed deadline has been missed", () => {
    expect(slaChip({ sla_status: "Breached", response_breached: true, response_due: "2026-11-02T09:15:00Z" }, now, "UTC")).toMatchObject({ tone: "red", text: "45 min overdue" });
    expect(slaChip({ sla_status: "Breached", response_breached: true, arrived_at: "2026-11-02T09:30:00Z", response_due: "2026-11-02T09:00:00Z" }, now, "UTC")).toMatchObject({ text: "Arrived late" });
    expect(
      slaChip({ sla_status: "Breached", resolution_breached: true, arrived_at: "2026-11-02T08:00:00Z", completed_at: "2026-11-02T09:00:00Z", resolution_due: "2026-11-02T08:30:00Z" }, now, "UTC"),
    ).toMatchObject({ text: "Finished late" });
  });

  it("is quiet about a job that is on track, and happy about one that met its target", () => {
    expect(slaChip({ sla_status: "On Track", response_due: "2026-11-02T14:00:00Z" }, now, "UTC")).toMatchObject({ tone: "neutral", text: "Arrive within 4 h" });
    expect(slaChip({ sla_status: "On Track", response_due: "2026-11-04T14:00:00Z" }, now, "UTC")?.text).toMatch(/^Due /);
    expect(slaChip({ sla_status: "Met", completed_at: "2026-11-02T09:00:00Z" }, now, "UTC")).toMatchObject({ tone: "green", text: "Service level met" });
  });
});

describe("the two clocks of a job", () => {
  const w = { response_due: "2026-11-02T12:00:00Z", resolution_due: "2026-11-03T08:00:00Z" };

  it("counts down while they run and counts up once overdue", () => {
    expect(slaClocks(w, now).map((c) => [c.state, c.text])).toEqual([
      ["running", "2 h left"],
      ["running", "22 h left"],
    ]);
    expect(slaClocks(w, at("2026-11-02T12:30:00Z"))[0]).toMatchObject({ state: "overdue", text: "30 min overdue" });
  });

  it("says whether a stopped clock stopped in time", () => {
    const early = slaClocks({ ...w, arrived_at: "2026-11-02T11:00:00Z" }, now);
    expect(early[0]).toMatchObject({ state: "met", text: "Arrived 1 h before the deadline" });
    expect(slaClocks({ ...w, arrived_at: "2026-11-02T12:20:00Z" }, now)[0]).toMatchObject({ state: "late", text: "Arrived 20 min after the deadline" });
    expect(slaClocks({ ...w, arrived_at: "2026-11-02T12:00:00Z" }, now)[0].text).toBe("Arrived just in time");
    expect(slaClocks({ ...w, completed_at: "2026-11-02T15:00:00Z" }, now)[1]).toMatchObject({ state: "met", text: "Finished 17 h before the deadline" });
  });

  it("has no clocks for a job with no targets", () => {
    expect(slaClocks({}, now)).toEqual([]);
  });
});
