/** Local-time helpers. All engagement decisions use these, never the server clock alone. */

export const MINUTES_PER_DAY = 24 * 60;

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
  };
}

export function minutesOfDay(parts: ZonedParts): number {
  return parts.hour * 60 + parts.minute;
}

export function localDateKey(parts: ZonedParts): string {
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

export function localTimeKey(parts: ZonedParts): string {
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${hour}:${minute}`;
}

/** Wrap any integer into [0, 1440). */
export function wrapMinutes(value: number): number {
  return ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** True when `now` is inside [start, start + duration), wrapping midnight. */
export function inWindow(now: number, start: number, duration: number): boolean {
  if (duration <= 0) return false;
  const current = wrapMinutes(now);
  const from = wrapMinutes(start);
  const span = Math.min(duration, MINUTES_PER_DAY);
  const end = from + span;
  if (end <= MINUTES_PER_DAY) return current >= from && current < end;
  return current >= from || current < end - MINUTES_PER_DAY;
}

/**
 * True from `start` until `end`. When start is later than end, the range
 * crosses midnight (22:30 → 07:00).
 */
export function inRange(now: number, start: number, end: number): boolean {
  const current = wrapMinutes(now);
  const from = wrapMinutes(start);
  const to = wrapMinutes(end);
  if (from === to) return false;
  if (from < to) return current >= from && current < to;
  return current >= from || current < to;
}

/** 7:00 AM, 6:30 PM. */
export function formatClock(minutes: number): string {
  const wrapped = wrapMinutes(minutes);
  const hour24 = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * Build an absolute instant that reads as the given civil time in `timeZone`.
 * One offset correction is enough for zones whose offset is stable that day.
 */
export function zonedDateTime(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = utcGuess;
  for (let i = 0; i < 2; i += 1) {
    const parts = zonedParts(new Date(instant), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    instant += wanted - asUtc;
  }
  return new Date(instant);
}

/** Median, rounded to the nearest 5 minutes. Empty input returns null. */
export function suggestTypicalMinutes(samples: number[]): number | null {
  const clean = samples
    .filter((value) => Number.isFinite(value))
    .map((value) => wrapMinutes(Math.round(value)))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  const median =
    clean.length % 2 === 1 ? clean[mid]! : Math.round((clean[mid - 1]! + clean[mid]!) / 2);
  return wrapMinutes(Math.round(median / 5) * 5);
}
