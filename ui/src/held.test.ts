import { beforeEach, describe, expect, it, vi } from "vitest";
import { docPath } from "@ferrum/client";
import { perform } from "./held";

// What reaches the server, in order.
const { calls } = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("./api", () => ({ act: async (...a: unknown[]) => void calls.push(["act", ...a]), reason: String }));
vi.mock("@ferrum/client", async (original) => {
  const real = await original<typeof import("@ferrum/client")>();
  // The job as it stands when the change is sent: the office added a part since.
  const job = { id: "w1", version: 7, checklist: [{ id: "c1", done: false }], parts: [{ id: "p9", item: "Filter" }] };
  return { ...real, api: { ...real.api, get: async () => job, patch: async (...a: unknown[]) => void calls.push(["patch", ...a]) } };
});

beforeEach(() => {
  calls.length = 0;
});

describe("sending a step held on the phone", () => {
  it("says when setting off, arriving and completing were taken", async () => {
    for (const action of ["start_travel", "arrive", "complete"] as const) await perform({ key: action, work_order: "w1", action, at: "2026-11-06T09:00:00.000Z", label: action });
    expect(calls).toEqual(["start_travel", "arrive", "complete"].map((a) => ["act", "ServiceWorkOrder", "w1", a, { at: "2026-11-06T09:00:00.000Z" }]));
  });

  it("makes a change again on the job as it stands, against its version", async () => {
    await perform({
      key: "s",
      work_order: "w1",
      action: "save",
      at: "2026-11-06T09:10:00.000Z",
      label: "Changes",
      edits: [
        { kind: "tick", row: "c1", done: true },
        { kind: "add", table: "parts", row: { item: "Seal", qty: "2" }, ref: "new-1" },
      ],
    });
    expect(calls).toEqual([["patch", docPath("ServiceWorkOrder", "w1"), { checklist: [{ id: "c1", done: true }], parts: [{ id: "p9" }, { item: "Seal", qty: "2" }] }, { ifMatch: 7 }]]);
  });

  it("refuses a picture no longer on the phone, so it is dropped with the reason", async () => {
    await expect(perform({ key: "p", work_order: "w1", action: "photo", at: "2026-11-06T09:20:00.000Z", label: "A photo", blob: "gone", file_name: "a.jpg" })).rejects.toThrow(
      "the photo is no longer on this phone",
    );
    expect(calls).toEqual([]);
  });
});
