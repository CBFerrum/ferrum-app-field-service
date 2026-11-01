// Money and hours arrive as decimal strings and are never put through binary floating point: sums
// and differences here are exact, so a cost and a bill can be set side by side.

interface Parsed {
  digits: bigint;
  scale: number;
}

function parse(value: string | number | null | undefined): Parsed {
  const text = String(value ?? "0").trim();
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (!m[2] && !m[3])) return { digits: 0n, scale: 0 };
  const frac = m[3] ?? "";
  const n = BigInt(`${m[2] || "0"}${frac}`);
  return { digits: m[1] === "-" ? -n : n, scale: frac.length };
}

function show({ digits, scale }: Parsed): string {
  const sign = digits < 0n ? "-" : "";
  const body = (digits < 0n ? -digits : digits).toString().padStart(scale + 1, "0");
  return scale ? `${sign}${body.slice(0, -scale)}.${body.slice(-scale)}` : `${sign}${body}`;
}

function align(a: Parsed, b: Parsed): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  const up = (p: Parsed) => p.digits * 10n ** BigInt(scale - p.scale);
  return [up(a), up(b), scale];
}

/** a + b, exactly. */
export function add(a: string | number | null | undefined, b: string | number | null | undefined): string {
  const [x, y, scale] = align(parse(a), parse(b));
  return show({ digits: x + y, scale });
}

/** a − b, exactly. */
export function sub(a: string | number | null | undefined, b: string | number | null | undefined): string {
  const [x, y, scale] = align(parse(a), parse(b));
  return show({ digits: x - y, scale });
}

/** The sum of any number of amounts. */
export const total = (values: (string | number | null | undefined)[]) => values.reduce<string>((sum, v) => add(sum, v), "0");

/** Whether an amount is more than nothing. */
export const positive = (v: string | number | null | undefined) => parse(v).digits > 0n;
