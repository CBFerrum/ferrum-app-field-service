import { describe, expect, it } from "vitest";
import { Serial } from "./serial";

const later = <T,>(value: T, ms = 1) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("writes, one after another", () => {
  it("runs jobs in the order they were queued, never two at once", async () => {
    const q = new Serial();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await later(null, ms);
      log.push(`end ${name}`);
      return name;
    };
    await Promise.all([q.add(job("a", 10)), q.add(job("b", 1)), q.add(job("c", 1))]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("drops the jobs behind one that failed, and starts afresh after", async () => {
    const q = new Serial();
    const ran: string[] = [];
    const first = q.add(async () => (ran.push("a"), false), (r) => r);
    const behind = q.add(async () => (ran.push("b"), true));
    expect(await first).toBe(false);
    expect(await behind).toBeNull();
    expect(await q.add(async () => (ran.push("c"), true))).toBe(true);
    expect(ran).toEqual(["a", "c"]);
  });

  it("treats a job that throws as a failure and still lets the next start afresh", async () => {
    const q = new Serial();
    const bad = q.add(async () => {
      throw new Error("offline");
    });
    const behind = q.add(async () => "b");
    await expect(bad).rejects.toThrow("offline");
    expect(await behind).toBeNull();
    expect(await q.add(async () => "c")).toBe("c");
  });

  it("counts what is waiting, dropped jobs included, and is idle when all are done", async () => {
    const q = new Serial();
    expect(q.idle).toBe(true);
    const a = q.add(async () => later(false), (r) => r);
    const b = q.add(async () => later(true));
    expect(q.pending).toBe(2);
    await Promise.all([a, b]);
    expect(q.pending).toBe(0);
    expect(q.idle).toBe(true);
  });
});
