// Time in a named zone, without a library. The server sends instants (UTC); the board draws them
// as the workspace's clock reads, and the date and time fields a dispatcher types are wall times
// in that zone, not in the browser's. Pure, so the daylight-saving edges are tested.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formats = new Map<string, Intl.DateTimeFormat>();

/** The zone if this browser knows it, else the fallback (a typo in a setting must not blank the board). */
export function knownZone(zone: string | null | undefined, fallback = "UTC"): string {
  for (const z of [zone, fallback]) {
    if (!z) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: z });
      return z;
    } catch {
      // Not a zone this browser knows.
    }
  }
  return "UTC";
}

function parts(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formats.set(zone, f);
  }
  return f;
}

export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What a wall clock in `zone` reads at the instant `ms`. */
export function wall(ms: number, zone: string): Wall {
  const out: Record<string, number> = {};
  for (const p of parts(zone).formatToParts(ms)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
export function offsetMs(ms: number, zone: string): number {
  const w = wall(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The local date (`YYYY-MM-DD`) of an instant. */
export function dayOf(ms: number, zone: string): string {
  const w = wall(ms, zone);
  return `${w.year}-${two(w.month)}-${two(w.day)}`;
}

/** The instant `minutes` after local midnight of `day`. A wall time that does not exist (the clocks
 *  went forward) is the instant it would have been before they did; one that happens twice takes
 *  its first occurrence, as the server does. */
export function instantOf(day: string, minutes: number, zone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, 0, minutes);
  const offsets = new Set([offsetMs(asUtc - DAY, zone), offsetMs(asUtc + DAY, zone)]);
  const real = [...offsets].map((o) => asUtc - o).filter((t) => offsetMs(t, zone) === asUtc - t);
  return real.length ? Math.min(...real) : asUtc - offsetMs(asUtc - DAY, zone);
}

/** `YYYY-MM-DD` plus whole days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

/** Whole days from one date to another. */
export function daysBetween(a: string, b: string): number {
  const at = (x: string) => {
    const [y, m, d] = x.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(b) - at(a)) / DAY);
}

/** Monday of the week a date is in. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

/** Whether text is a real calendar date (the engine takes 30 February for 2 March, so it is checked back). */
export function isDay(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "10:15" or "10:15 AM", as the viewer's locale writes it, in `zone`. */
export function clock(ms: number, zone: string): string {
  let f = clocks.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" });
    clocks.set(zone, f);
  }
  return f.format(ms);
}

const hoursOnly = new Map<string, Intl.DateTimeFormat>();

/** The label of an hour on a ruler: "10" or "10 AM". */
export function hourLabel(ms: number, zone: string): string {
  let f = hoursOnly.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric" });
    hoursOnly.set(zone, f);
  }
  return f.format(ms);
}

/** "Mon 2 Nov" for a date (no zone: a date is a date). */
export function dayLabel(day: string, o: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...o, timeZone: "UTC" });
}

/** "Mon 2 Nov, 10:15" in `zone`. */
export function stamp(ms: number, zone: string): string {
  return `${dayLabel(dayOf(ms, zone))}, ${clock(ms, zone)}`;
}

/** The value of a `datetime-local` field showing an instant as `zone`'s wall clock. */
export function wallInput(ms: number, zone: string): string {
  const w = wall(ms, zone);
  return `${w.year}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}`;
}

/** The instant a `datetime-local` value names on `zone`'s wall clock, or null if it is not one. */
export function fromWallInput(value: string, zone: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m || !isDay(m[1])) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return minutes < 1440 ? instantOf(m[1], minutes, zone) : null;
}

/** A length of time in the words a dispatcher uses: "25 min", "1 h 30 min", "2 days". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)} days`;
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Rounds minutes to the nearest step (the board snaps to quarter hours). */
export const snap = (minutes: number, step = 15) => Math.round(minutes / step) * step;
