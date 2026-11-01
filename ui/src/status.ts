// How a work order's status reads on a badge, and the steps it passes through. The statuses are
// the server's; this only gives them tones and an order.

import type { Tone } from "./sla";

export const STATUS_TONE: Record<string, Tone> = {
  New: "neutral",
  Scheduled: "neutral",
  Dispatched: "blue",
  "En Route": "purple",
  "On Site": "purple",
  Completed: "green",
  Invoiced: "green",
  Cancelled: "red",
  "Cannot Complete": "amber",
};

export const tone = (status: string | null | undefined): Tone => STATUS_TONE[status ?? ""] ?? "neutral";

/** The statuses a work order passes through, in order (Cancelled leaves them). */
export const STEPS = ["New", "Scheduled", "Dispatched", "En Route", "On Site", "Completed", "Invoiced"] as const;

/** Priorities, most urgent first. */
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"] as const;

export const priorityTone = (p: string | null | undefined): Tone => (p === "Urgent" ? "red" : p === "High" ? "amber" : "neutral");
