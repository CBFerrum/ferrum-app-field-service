import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { axisFor, type Lane, type Visit } from "./board";
import { Grid, type LaneOps } from "./Lanes";

const t = (hhmm: string) => `2026-11-02T${hhmm}:00.000Z`;
const visit = (n: string, from: string, to: string, extra: Partial<Visit> = {}): Visit => ({
  appointment: `a${n}`,
  number: `FSA-${n}`,
  status: "Dispatched",
  start: t(from),
  end: t(to),
  actual_start: null,
  actual_end: null,
  work_order: `w${n}`,
  work_order_number: `FSWO-${n}`,
  customer_name: `Customer ${n}`,
  priority: "Urgent",
  site: null,
  travel: null,
  ...extra,
});
const lane = (id: string, appointments: Visit[], extra: Partial<Lane> = {}): Lane => ({
  technician: id,
  technician_name: `Asha ${id}`,
  user_email: null,
  territory: null,
  territory_name: "North",
  time_zone: "UTC",
  home: null,
  working_hours: [{ start: t("09:00"), end: t("17:00") }],
  available_hours: "8",
  booked_hours: "2.5",
  appointments,
  ...extra,
});
const ops: LaneOps = { canPlan: true, hold: () => {}, hover: () => {}, drop: () => {}, resize: () => {}, select: () => {}, key: () => {}, dismiss: () => {} };

describe("the lanes, drawn", () => {
  const lanes = [
    lane("a", [visit("1", "09:00", "10:00"), visit("2", "10:20", "11:00", { status: "Scheduled", travel: { from: "FSA-1", km: "9", minutes: 35 } })]),
    lane("b", [], { working_hours: [], available_hours: "0" }),
  ];
  const axis = axisFor("2026-11-02", "UTC", lanes);
  const html = renderToStaticMarkup(<Grid lanes={lanes} axis={axis} perHour={64} now={Date.parse(t("10:00"))} held={null} hover={null} selected="w1" notices={{ b: "Asha b is already booked." }} tabId="a1" ops={ops} />);

  it("draws a lane for each technician with how full the day is", () => {
    expect(html.match(/class="fs-lane"/g)).toHaveLength(2);
    expect(html).toContain("2.5 of 8 h");
    expect(html).toContain("Not working");
  });

  it("draws each visit as a block, planned ones as needing dispatch, and the chosen one as pressed", () => {
    expect(html.match(/data-appointment=/g)).toHaveLength(2);
    expect(html).toContain('data-status="scheduled"');
    expect(html).toContain("Needs dispatch");
    expect(html).toMatch(/data-appointment="a1"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-appointment="a1"/);
  });

  it("flags the drive that does not fit, and shades the hours outside work", () => {
    expect(html).toContain("data-late");
    expect(html).toContain("fs-travel");
    expect(html).toContain("fs-off");
  });

  it("shows the server's refusal on its lane and the present moment on the day", () => {
    expect(html).toContain('role="alert"');
    expect(html).toContain("Asha b is already booked.");
    expect(html).toContain("fs-now");
  });

  it("gives one block a place in the tab order, besides the scrolling lanes themselves", () => {
    expect(html.match(/<div[^>]*tabindex="0"[^>]*data-appointment/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(2);
  });
});
