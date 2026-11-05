import { afterEach, describe, expect, it } from "vitest";
import { ApiError, resetBootstrap } from "@ferrum/client";
import { fakeBootstrap } from "@ferrum/testing";
import { applied, type Edit, edits, forgetAdd, hold, keepDay, keptDay, memoryBlobs, patchFor, send, type Step, unreachable, type Waiting, waiting } from "./offline";

function memory() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

function as(offline: unknown) {
  (globalThis as { __FERRUM_BOOTSTRAP__?: unknown }).__FERRUM_BOOTSTRAP__ = fakeBootstrap({ offline } as never);
  resetBootstrap();
}

const lease = { allowed: true, until: "2999-01-01T00:00:00Z", hours: 72, key: "k1", person: "p1" };

afterEach(() => {
  delete (globalThis as { __FERRUM_BOOTSTRAP__?: unknown }).__FERRUM_BOOTSTRAP__;
  resetBootstrap();
});

describe("the day without a connection", () => {
  it("keeps the day under the lease, and not without one", () => {
    const store = memory();
    as(lease);
    expect(keepDay("2026-11-06", { jobs: 2 }, store, new Date("2026-11-06T07:00:00Z"))).toBe(true);
    expect(keptDay<{ jobs: number }>("2026-11-06", store)).toEqual({ day: "2026-11-06", at: "2026-11-06T07:00:00.000Z", data: { jobs: 2 } });
    expect(keptDay("2026-11-07", store)).toBeNull();
    as({ ...lease, key: "k2" });
    expect(keptDay("2026-11-06", store)).toBeNull();
    as({ ...lease, allowed: false, until: null });
    expect(keepDay("2026-11-06", { jobs: 2 }, store)).toBe(false);
  });

  it("sends steps in the order taken, waits when unreachable, drops what is refused", async () => {
    const store = memory();
    as({ ...lease, allowed: false, until: null });
    hold({ work_order: "w1", action: "start_travel", at: "2026-11-06T08:00:00Z", label: "On your way to Acme" }, store);
    hold({ work_order: "w1", action: "arrive", at: "2026-11-06T08:30:00Z", label: "On site at Acme" }, store);
    hold({ work_order: "w2", action: "start_travel", at: "2026-11-06T10:00:00Z", label: "On your way to Globex" }, store);
    expect(waiting(store).map((w) => w.action)).toEqual(["start_travel", "arrive", "start_travel"]);
    // The connection drops after the first: the rest wait, in order.
    let calls = 0;
    const down = await send(async () => {
      if (calls++ > 0) throw new TypeError("Failed to fetch");
    }, String, store);
    expect(down.sent.map((w) => w.label)).toEqual(["On your way to Acme"]);
    expect(waiting(store).map((w) => w.label)).toEqual(["On site at Acme", "On your way to Globex"]);
    // Back: one is refused (the job moved meanwhile), and is dropped with its reason.
    const refused = new ApiError(422, "invalid", "This job was given to someone else.");
    const back = await send(async (w) => {
      if (w.work_order === "w2") throw refused;
    }, (e) => (e as Error).message, store);
    expect(back.sent.map((w) => w.label)).toEqual(["On site at Acme"]);
    expect(back.refused.map((r) => [r.step.label, r.reason])).toEqual([["On your way to Globex", "This job was given to someone else."]]);
    expect(waiting(store)).toEqual([]);
    expect([unreachable(new TypeError("x")), unreachable({ status: 503 }), unreachable({ status: 401 }), unreachable(refused)]).toEqual([true, true, true, false]);
  });
});

describe("a job's changes without a connection", () => {
  const job = {
    id: "w1",
    status: "On Site",
    checklist: [
      { id: "c1", task: "Check the pressure", done: false },
      { id: "c2", task: "Bleed the radiators", done: false },
    ],
    parts: [{ id: "p1", item: "Valve", qty: "1" }],
    work_notes: null as string | null,
  };
  type Job = typeof job & { customer_signature?: string; signed_by?: string; signed_at?: string };
  // What the page sends (a table's rows whole: kept ones by id, a new one without) and shows.
  const fields = { checklist: [{ id: "c1", done: true }, { id: "c2", done: false }], parts: [{ item: "Seal", qty: "2" }], work_notes: "Replaced the seal" };
  const shown = { ...fields, parts: [{ id: "new-1", item: "Seal", qty: "2" }] };

  it("keeps what a save does, not the rows it sends", () => {
    expect(edits(job, fields, shown)).toEqual([
      { kind: "tick", row: "c1", done: true },
      { kind: "add", table: "parts", row: { item: "Seal", qty: "2" }, ref: "new-1" },
      { kind: "remove", table: "parts", row: "p1" },
      { kind: "set", field: "work_notes", value: "Replaced the seal" },
    ]);
  });

  it("makes it again on the job as it stands, without undoing anyone else's change", () => {
    // Meanwhile the office took out the second task and added a part.
    const now = { ...job, checklist: [job.checklist[0]], parts: [...job.parts, { id: "p9", item: "Filter", qty: "1" }] };
    expect(patchFor(now, edits(job, fields, shown))).toEqual({
      work_notes: "Replaced the seal",
      checklist: [{ id: "c1", done: true }],
      parts: [{ id: "p9" }, { item: "Seal", qty: "2" }],
    });
    // A tick of a task taken out meanwhile leaves nothing to send.
    expect(patchFor({ ...job, checklist: [] }, [{ kind: "tick", row: "c1", done: true }])).toBeNull();
  });

  it("shows the job as the technician left it", () => {
    const steps: Waiting[] = [
      { key: "a", work_order: "w1", at: "2026-11-06T09:00:00Z", label: "On site", action: "arrive" },
      { key: "b", work_order: "w1", at: "2026-11-06T09:10:00Z", label: "Changes", action: "save", edits: edits(job, fields, shown) },
      { key: "c", work_order: "w1", at: "2026-11-06T09:20:00Z", label: "Signed by Pat", action: "sign", blob: "k1", signed_by: "Pat Morgan" },
      { key: "d", work_order: "w2", at: "2026-11-06T09:30:00Z", label: "Completed: Globex", action: "complete" },
    ];
    const left = applied<Job>({ ...job, status: "En Route" }, steps);
    expect(left.status).toBe("On Site");
    expect(left.checklist.map((r) => r.done)).toEqual([true, false]);
    expect(left.parts).toEqual([{ id: "new-1", item: "Seal", qty: "2" }]);
    expect([left.work_notes, left.customer_signature, left.signed_by, left.signed_at]).toEqual(["Replaced the seal", "held:k1", "Pat Morgan", "2026-11-06T09:20:00Z"]);
  });

  it("forgets a row added and taken out again before it was sent", () => {
    const store = memory();
    as({ ...lease, allowed: false, until: null });
    const save = (...list: Edit[]): Step => ({ work_order: "w1", action: "save", at: "2026-11-06T09:00:00Z", label: "Changes", edits: list });
    const add = (ref: string): Edit => ({ kind: "add", table: "parts", row: { item: "Seal" }, ref });
    hold(save(add("new-1"), { kind: "set", field: "work_notes", value: "Seal" }), store);
    hold(save(add("new-2")), store);
    expect([forgetAdd("new-1", store), forgetAdd("new-2", store), forgetAdd("p1", store)]).toEqual([true, true, false]);
    expect(waiting(store)).toMatchObject([{ action: "save", edits: [{ kind: "set", field: "work_notes", value: "Seal" }] }]);
  });

  it("sends steps taken meanwhile; a refusal keeps only its job from completing; pictures go once sent", async () => {
    const store = memory();
    as({ ...lease, allowed: false, until: null });
    const blobs = memoryBlobs();
    await blobs.put("sig", new Blob(["png"]));
    await blobs.put("photo", new Blob(["jpg"]));
    hold({ work_order: "w1", action: "save", at: "2026-11-06T09:00:00Z", label: "Changes: Acme", edits: [{ kind: "set", field: "work_notes", value: "x" }] }, store);
    hold({ work_order: "w1", action: "photo", at: "2026-11-06T09:05:00Z", label: "A photo", blob: "photo", file_name: "boiler.jpg" }, store);
    hold({ work_order: "w1", action: "sign", at: "2026-11-06T09:10:00Z", label: "Signed by Pat", blob: "sig", signed_by: "Pat Morgan" }, store);
    hold({ work_order: "w1", action: "complete", at: "2026-11-06T09:15:00Z", label: "Completed: Acme" }, store);
    hold({ work_order: "w2", action: "arrive", at: "2026-11-06T10:00:00Z", label: "On site: Globex" }, store);
    const runs: string[] = [];
    const out = await send(
      async (w) => {
        runs.push(w.label);
        // The technician works on while it sends: what they do waits behind the rest.
        if (w.action === "photo") hold({ work_order: "w2", action: "complete", at: "2026-11-06T10:30:00Z", label: "Completed: Globex" }, store);
        if (w.action === "save") throw new ApiError(422, "invalid", "The notes are too long.");
      },
      (e) => (e as Error).message,
      store,
      blobs,
    );
    expect(runs).toEqual(["Changes: Acme", "A photo", "Signed by Pat", "On site: Globex", "Completed: Globex"]);
    expect(out.refused.map((r) => [r.step.label, r.reason])).toEqual([["Changes: Acme", "The notes are too long."]]);
    expect(out.dropped.map((w) => w.label)).toEqual(["Completed: Acme"]);
    expect(out.sent.map((w) => w.label)).toEqual(["A photo", "Signed by Pat", "On site: Globex", "Completed: Globex"]);
    expect(waiting(store)).toEqual([]);
    expect([await blobs.get("sig"), await blobs.get("photo")]).toEqual([undefined, undefined]);
  });

  it("keeps a picture while its step cannot reach the server", async () => {
    const store = memory();
    as({ ...lease, allowed: false, until: null });
    const blobs = memoryBlobs();
    await blobs.put("photo", new Blob(["jpg"]));
    hold({ work_order: "w1", action: "photo", at: "2026-11-06T09:05:00Z", label: "A photo", blob: "photo", file_name: "boiler.jpg" }, store);
    const out = await send(async () => Promise.reject(new TypeError("Failed to fetch")), String, store, blobs);
    expect(out.sent).toEqual([]);
    expect(waiting(store).map((w) => w.label)).toEqual(["A photo"]);
    expect(await blobs.get("photo")).toBeInstanceOf(Blob);
  });
});
