import { describe, expect, it } from "vitest";
import { sentence } from "./reason";

describe("a refusal as a sentence", () => {
  it("keeps a message that is a sentence already", () => {
    expect(sentence([{ field: "technician", message: "Asha Rao is already booked Mon 2 Nov 10:00–12:00 on FSA-2026-000012" }])).toBe("Asha Rao is already booked Mon 2 Nov 10:00–12:00 on FSA-2026-000012.");
  });

  it("puts the field in front of one that starts mid-sentence", () => {
    expect(sentence([{ field: "scheduled_end", message: "must be after the start" }])).toBe("Scheduled end must be after the start.");
  });

  it("joins several, once each", () => {
    expect(
      sentence([
        { field: "done", message: "required task not done: Inspect the flue" },
        { field: "done", message: "required task not done: Inspect the flue" },
        { field: "signed_by", message: "the name of the person who signed is required" },
      ]),
    ).toBe("Required task not done: Inspect the flue. The name of the person who signed is required.");
  });

  it("has nothing to say about no refusals", () => {
    expect(sentence([])).toBeNull();
  });
});
