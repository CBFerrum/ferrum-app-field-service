// What the server refused, as one sentence to show where it happened. The platform sends each
// refusal with the field it is about ("technician": "Asha Rao is already booked ..."); a message
// that is only the end of one ("must be after the start") needs its field in front of it.

export interface Refusal {
  field: string;
  message: string;
}

const words = (field: string) =>
  field
    .split("_")
    .filter(Boolean)
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());

/** Messages that finish a sentence about their field rather than begin one. */
const ENDING = /^(must|cannot|can't|is|are|should|at most|at least|use|not|needs|has)\b/;

/** The refusals as a sentence, or null when there are none. */
export function sentence(refusals: Refusal[]): string | null {
  if (!refusals.length) return null;
  const said = refusals.map((r) => {
    const message = r.message.trim().replace(/\.$/, "");
    return ENDING.test(message) ? `${words(r.field)} ${message}` : message.replace(/^./, (c) => c.toUpperCase());
  });
  return `${[...new Set(said)].join(". ")}.`;
}
