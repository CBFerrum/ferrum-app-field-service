import { afterEach, describe, expect, it } from "vitest";
import { ApiError, resetBootstrap } from "@ferrum/client";
import { fakeBootstrap } from "@ferrum/testing";
import { hold, keepDay, keptDay, send, unreachable, waiting } from "./offline";

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
