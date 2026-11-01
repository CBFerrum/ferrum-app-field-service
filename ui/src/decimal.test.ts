import { describe, expect, it } from "vitest";
import { add, positive, sub, total } from "./decimal";

describe("exact amounts", () => {
  it("adds without binary rounding", () => {
    expect(add("0.1", "0.2")).toBe("0.3");
    expect(add("1250.50", "32.5")).toBe("1283.00");
    expect(add("-5", "2.25")).toBe("-2.75");
    expect(total(["0.1", "0.2", "0.3", null, undefined, 2])).toBe("2.6");
  });

  it("subtracts, and goes below nothing", () => {
    expect(sub("10", "12.5")).toBe("-2.5");
    expect(sub("12.50", "12.5")).toBe("0.00");
  });

  it("reads what is not a number as nothing", () => {
    expect(add("", "x")).toBe("0");
    expect(add(undefined, "3")).toBe("3");
  });

  it("knows when there is something", () => {
    expect([positive("0.01"), positive("0"), positive("-1"), positive(null)]).toEqual([true, false, false, false]);
  });
});
