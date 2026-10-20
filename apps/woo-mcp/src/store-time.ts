import { STORE_TIMEZONE } from '@urumi/contracts';

/** One calendar day in a time zone, as the half-open UTC interval `[after, before)`. */
export interface DayWindow {
  /** The calendar day, `YYYY-MM-DD`. */
  date: string;
  timezone: string;
  /** Start of the day (inclusive), UTC ISO 8601. */
  after: string;
  /** Start of the next day (exclusive), UTC ISO 8601. */
  before: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of `instant` in `timeZone`. */
function wallClock(instant: number, timeZone: string) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in ms (IST: +19 800 000). */
function zoneOffsetMs(instant: number, timeZone: string) {
  const w = wallClock(instant, timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of 00:00 on y-m-d in `timeZone`; re-checks the offset so DST zones work too. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string) {
  const wallAsUtc = Date.UTC(year, month - 1, day);
  const guess = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  return wallAsUtc - zoneOffsetMs(guess, timeZone);
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, '0');
}

/** True for a real `YYYY-MM-DD` calendar date (so `2026-02-30` is false). */
export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1970) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** The store's calendar date at `now`, `YYYY-MM-DD`. */
export function storeDate(now: Date, timeZone: string = STORE_TIMEZONE): string {
  const w = wallClock(now.getTime(), timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * `[start, end)` of a calendar day in the store time zone, in UTC. `date` is `'today'` (the store's
 * date at `now`) or `YYYY-MM-DD`. Throws RangeError for anything else.
 */
export function dayWindow(date: string, now: Date, timeZone: string = STORE_TIMEZONE): DayWindow {
  const day = date === 'today' ? storeDate(now, timeZone) : date;
  if (!isCalendarDate(day)) throw new RangeError('Not a calendar date');
  const [year, month, dom] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, dom + 1));
  const start = zonedMidnight(year, month, dom, timeZone);
  const end = zonedMidnight(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone,
  );
  return {
    date: day,
    timezone: timeZone,
    after: new Date(start).toISOString(),
    before: new Date(end).toISOString(),
  };
}

/**
 * An instant as the UTC wall time WooCommerce compares against `date_created_gmt` when
 * `dates_are_gmt=true`: `YYYY-MM-DDTHH:mm:ss`, deliberately without `Z`. WordPress's date query
 * converts any zoned value into the site's own time zone before comparing it with the GMT column,
 * so a `Z` would shift the window by the site offset; a naive value is compared as-is.
 */
export function toWooGmt(instant: Date | string | number): string {
  return new Date(instant).toISOString().slice(0, 19);
}
