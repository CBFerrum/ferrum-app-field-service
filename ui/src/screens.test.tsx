// The screens, drawn on the server with the data they would be given: this catches a screen that
// cannot draw at all, and says what a person would read on it. (Interaction is checked in a browser.)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Board, Job, Visit } from "./board";
import { StopCard } from "./Day";
import { Drawer, type DrawerOps } from "./Drawer";
import type { Details } from "./journey";
import { JobSheet, type View } from "./JobSheet";
import { QueueCard } from "./Queue";
import { Week } from "./Week";
import { Checklist, type Ctx, Expenses, Parts, Time } from "./Sections";

const at = (iso: string) => Date.parse(iso);
const now = at("2026-11-02T10:00:00Z");
const page = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

const visit: Visit = {
  appointment: "a1",
  number: "FSA-1",
  status: "Dispatched",
  start: "2026-11-02T11:00:00.000Z",
  end: "2026-11-02T12:30:00.000Z",
  actual_start: null,
  actual_end: null,
  work_order: "w1",
  work_order_number: "FSWO-1",
  customer_name: "Acme Boilers",
  priority: "High",
  site: null,
  travel: { from: "home", km: "6.4", minutes: 14 },
};

const job: Job = {
  work_order: "w2",
  number: "FSWO-2",
  customer_name: "Bright Dental",
  priority: "Urgent",
  work_type: "Repair",
  reported_at: "2026-11-02T08:00:00.000Z",
  response_due: "2026-11-02T10:40:00.000Z",
  resolution_due: "2026-11-03T08:00:00.000Z",
  sla_status: "At Risk",
  response_breached: false,
  territory: null,
  territory_name: "North",
  site: null,
  estimated_duration_minutes: 90,
  preferred_start: null,
  required_skills: ["Gas safe", "HVAC", "Welding", "Electrics"],
};

describe("the waiting job's card", () => {
  const html = page(<QueueCard job={job} zone="UTC" now={now} selected={false} canPlan tab busy={false} onSelect={() => {}} onHold={() => {}} onKey={() => {}} />);

  it("says who, what and how urgent, in words as well as colour", () => {
    expect(html).toContain("Bright Dental");
    expect(html).toContain("Urgent");
    expect(html).toContain("Arrive within 40 min");
    expect(html).toContain("1 h 30 min");
    expect(html).toContain("+1");
  });

  it("can be dragged by someone who plans, and not by someone who does not", () => {
    expect(html).toContain('draggable="true"');
    expect(page(<QueueCard job={job} zone="UTC" now={now} selected={false} canPlan={false} tab busy={false} onSelect={() => {}} onHold={() => {}} onKey={() => {}} />)).toContain('draggable="false"');
  });
});

describe("a stop on the technician's day", () => {
  const details: Details = { id: "w1", customer_name: "Acme Boilers", site_address: "14 High St\nLeeds", contact_name: "Pat Morgan", contact_phone: "07700 900123", status: "Dispatched", priority: "High", latitude: "53.8", longitude: "-1.55" };

  it("offers the one step that is next, the way there and the number to call", () => {
    const html = page(<StopCard stop={{ visit, job: details }} zone="UTC" now={now} current busy={false} onGo={() => {}} />);
    expect(html).toContain("Start travel");
    expect(html).toContain("https://www.google.com/maps/dir/?api=1&amp;destination=53.8%2C-1.55");
    expect(html).toContain('href="tel:07700900123"');
    expect(html).toContain("Call Pat");
    expect(html).toContain("About 14 min to get there");
    expect(html).toContain("14 High St");
  });

  it("offers to finish a job that is on site, and nothing for one that waits to be dispatched", () => {
    expect(page(<StopCard stop={{ visit, job: { ...details, status: "On Site" } }} zone="UTC" now={now} current busy={false} onGo={() => {}} />)).toContain("Finish the job");
    const waits = page(<StopCard stop={{ visit, job: { ...details, status: "Scheduled" } }} zone="UTC" now={now} current busy={false} onGo={() => {}} />);
    expect(waits).toContain("Waiting for the dispatcher");
    expect(waits).not.toContain("Start travel");
  });

  it("offers no step on a job that is not the one in hand", () => {
    expect(page(<StopCard stop={{ visit, job: details }} zone="UTC" now={now} current={false} busy={false} onGo={() => {}} />)).not.toContain("Start travel");
  });
});

const row = (id: string, task: string, required: boolean, done: boolean) => ({ id, task, required, done });
const ctx = (doc: Record<string, unknown>, over: Partial<Ctx> = {}): Ctx => ({
  id: "w1",
  doc: { id: "w1", docstatus: 0, status: "On Site", ...doc },
  zone: "UTC",
  editable: true,
  office: false,
  save: async () => ({ ok: true, fields: [] }),
  refused: [],
  expenseTypes: [],
  ...over,
});

describe("the sections a technician fills in", () => {
  it("shows the checklist with large ticks, what is required, and how far it is", () => {
    const html = page(<Checklist ctx={ctx({ checklist: [row("c1", "Inspect the flue", true, false), row("c2", "Test the valve", false, true)] })} />);
    expect(html).toContain("1 of 2 done");
    expect(html).toContain("Inspect the flue");
    expect(html).toContain("Required");
    expect(html).toContain('aria-valuenow="1"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain("disabled");
  });

  it("locks the ticks once the job is completed, and says what the server refused beside the task", () => {
    const html = page(<Checklist ctx={ctx({ checklist: [row("c1", "Inspect the flue", true, false)] }, { editable: false, refused: [{ field: "done", message: "required task not done: Inspect the flue", row: ["checklist", 0] }] })} />);
    expect(html).toContain("disabled");
    expect(html).toContain("required task not done: Inspect the flue");
  });

  it("lists parts with their serial numbers and warranty, and lets one be added", () => {
    const html = page(<Parts ctx={ctx({ parts: [{ id: "p1", item_name: "Diverter valve", qty: "1", serial_no: "SN1\nSN2", warranty: true }] })} />);
    expect(html).toContain("Diverter valve");
    expect(html).toContain("Serial SN1, SN2");
    expect(html).toContain("Under warranty");
    expect(html).toContain("Add a part");
    expect(page(<Parts ctx={ctx({ parts: [] }, { editable: false })} />)).not.toContain("Add a part");
  });

  it("shows the time spent and a timer to start", () => {
    const html = page(<Time ctx={ctx({ labour: [{ id: "l1", hours: "1.5", technician_name: "Asha Rao", from_time: "2026-11-02T09:00:00.000Z", to_time: "2026-11-02T10:30:00.000Z", billable: true }] })} />);
    expect(html).toContain("1.5 h");
    expect(html).toContain("Start timer");
    expect(html).toContain("Forgot the timer?");
  });

  it("totals the expenses", () => {
    const html = page(<Expenses ctx={ctx({ expenses: [{ id: "e1", expense_type: "Parking", amount: "12.50", billable: true }], expense_total: "12.50" })} />);
    expect(html).toContain("Parking");
    expect(html).toContain("12.50");
    expect(html).toContain("Add an expense");
  });
});

const view = (doc: Record<string, unknown>, over: Partial<View> = {}): View => ({
  ctx: ctx(doc),
  rules: { require_checklist: true, require_signature: true },
  run: async () => ({ ok: true, fields: [] }),
  setRefused: () => {},
  now,
  switch: false,
  saving: false,
  ...over,
});
const wo = {
  number: "FSWO-2026-00001",
  customer_name: "Acme Boilers",
  work_type: "Repair",
  priority: "Medium",
  site_address: "14 High St",
  contact_name: "Pat Morgan",
  contact_phone: "07700 900123",
  scheduled_start: "2026-11-02T11:00:00.000Z",
  scheduled_end: "2026-11-02T12:30:00.000Z",
  checklist: [row("c1", "Inspect the flue", true, false)],
};

describe("the job as the technician works it", () => {
  it("offers start travel on a dispatched job, or skipping it", () => {
    const html = page(<JobSheet v={view({ ...wo, status: "Dispatched" })} />);
    expect(html).toContain("Start travel");
    expect(html).toContain("Already here");
    expect(html).toContain("Acme Boilers");
    expect(html).toContain("Directions");
  });

  it("says what is left before the job can be completed", () => {
    const html = page(<JobSheet v={view({ ...wo, status: "On Site" })} />);
    expect(html).toContain("Complete the job");
    expect(html).toContain("Still to do");
    expect(html).toContain("1 required task is not done");
    expect(html).toContain("The customer has not signed");
  });

  it("is ready when everything is in", () => {
    const html = page(<JobSheet v={view({ ...wo, status: "On Site", checklist: [row("c1", "Inspect the flue", true, true)], customer_signature: "/files/1", signed_by: "Pat Morgan" })} />);
    expect(html).toContain("Everything is in");
    expect(html).not.toContain("Still to do");
  });

  it("offers nothing to do on a job that waits for dispatch, or is done", () => {
    const waits = page(<JobSheet v={view({ ...wo, status: "Scheduled" })} />);
    expect(waits).toContain("Waiting for the dispatcher");
    expect(waits).toContain("Back to my day");
    expect(page(<JobSheet v={view({ ...wo, status: "Completed", docstatus: 1 }, { ctx: ctx({ ...wo, status: "Completed", docstatus: 1 }, { editable: false }) })} />)).not.toContain("Add a part");
  });

  it("tells what the server refused when completing", () => {
    const html = page(<JobSheet v={view({ ...wo, status: "On Site" }, { ctx: ctx({ ...wo, status: "On Site" }, { refused: [{ field: "customer_signature", message: "the customer's signature is required to complete the work order" }] }) })} />);
    expect(html).toContain("The job cannot be completed yet");
    expect(html).toContain("The customer&#x27;s signature is required");
  });
});

describe("the drawer", () => {
  const board: Board = {
    from: "2026-11-02",
    to: "2026-11-02",
    time_zone: "UTC",
    travel_speed_kmh: "40",
    technicians: [{ technician: "t1", technician_name: "Asha Rao", user_email: null, territory: null, territory_name: null, time_zone: "UTC", home: null, working_hours: [], available_hours: null, booked_hours: "1.5", appointments: [{ ...visit, status: "Scheduled" }] }],
    unscheduled: [job],
  };
  const ops: DrawerOps = { assign: async () => null, relocate: async () => null, dispatch: async () => null, cancel: async () => null };
  const draw = (workOrder: string, canPlan = true) => page(<Drawer board={board} workOrder={workOrder} canPlan={canPlan} now={now} startHint={now} ops={ops} moving={false} onMoving={() => {}} onClose={() => {}} />);

  it("offers to rank the technicians for a waiting job", () => {
    const html = draw("w2");
    expect(html).toContain("Bright Dental");
    expect(html).toContain("Who can take it");
    expect(html).toContain('type="datetime-local"');
  });

  it("explains a visit that is planned but not sent, and offers to dispatch it", () => {
    const html = draw("w1");
    expect(html).toContain("Planned, not sent");
    expect(html).toContain("Dispatch");
    expect(html).toContain("Reschedule…");
    expect(html).toContain("Cancel visit");
  });

  it("only shows a job to someone who does not plan", () => {
    const html = draw("w1", false);
    expect(html).not.toContain("Reschedule…");
    expect(html).not.toContain("Cancel visit");
  });
});

describe("the week", () => {
  const lane = {
    technician: "t1",
    technician_name: "Asha Rao",
    user_email: null,
    territory: null,
    territory_name: "North",
    time_zone: "UTC",
    home: null,
    working_hours: [{ start: "2026-11-02T09:00:00.000Z", end: "2026-11-02T17:00:00.000Z" }],
    available_hours: "8",
    booked_hours: "9.5",
    appointments: [{ ...visit, status: "Scheduled", start: "2026-11-02T09:00:00.000Z", end: "2026-11-02T18:30:00.000Z" }],
  };
  const board: Board = { from: "2026-11-02", to: "2026-11-08", time_zone: "UTC", travel_speed_kmh: "40", technicians: [lane], unscheduled: [] };
  const html = page(<Week board={board} first="2026-11-02" today="2026-11-03" onOpen={() => {}} />);

  it("shows each day's load and opens a day", () => {
    expect(html).toContain("9.5 of 8 h");
    expect(html).toContain("1 job");
    expect(html).toContain("Off");
    expect(html).toContain("booked past their hours");
    expect(html.match(/<button/g)).toHaveLength(7);
  });

  it("marks today", () => {
    expect(html).toContain("data-today");
  });
});
