import { describe, expect, it } from "vitest";
import { home, plans, works } from "./roles";

describe("who does what", () => {
  it("lets dispatchers, service managers and administrators plan", () => {
    expect(plans({ roles: ["Dispatcher"] })).toBe(true);
    expect(plans({ roles: ["Service Manager"] })).toBe(true);
    expect(plans({ is_admin: true, roles: [] })).toBe(true);
    expect(plans({ roles: ["Technician"] })).toBe(false);
    expect(plans(undefined)).toBe(false);
  });

  it("gives technicians a day of their own", () => {
    expect(works({ roles: ["Technician"] })).toBe(true);
    expect(works({ roles: ["Dispatcher"] })).toBe(false);
  });

  it("opens the board for a planner and the day for everyone else", () => {
    expect(home({ roles: ["Dispatcher", "Technician"] })).toBe("/dispatch");
    expect(home({ roles: ["Technician"] })).toBe("/day");
    expect(home(null)).toBe("/day");
  });
});
