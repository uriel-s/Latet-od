// Calendar dates and pickup times as the app shows them, in Israel's time zone (spec §7,
// CLAUDE.md): "DD/MM" and a 24-hour "08:00" in Hebrew, "Nov 4" and "8:00 AM" in English, plus the
// weekday name of a day ("יום רביעי" / "Wednesday") for the WhatsApp message. Shared so
// the collector app's tags ("לא הגענו אליו · 12/11"), the customer's page and anything the api writes
// read a day the same way, whatever zone the code runs in (UTC on Vercel, the phone's own zone in
// the browser). Also the calendar months of the monthly statistics (spec §3.7): which month an
// instant counts in, and the instants a month covers, both in Israel's zone.
import { z } from 'zod';
import type { Lang } from './i18n.ts';

/**
 * The app's time zone. Every calendar day the app shows or stores (a round's date,
 * `lastMiss.date`) is a day in Israel, and so is every month of the monthly statistics: an order
 * collected at 01:00 on the 1st, Israel time, counts in the new month although it is still the
 * previous month in UTC.
 */
export const APP_TIME_ZONE = 'Asia/Jerusalem';

/**
 * A calendar date `YYYY-MM-DD`, a real day included (no 2026-02-30). The same check as
 * `lastMissSchema.date`, so whatever the order stores, this module can show.
 */
const isoCalendarDateSchema = z.iso.date();

// Built once: creating an Intl.DateTimeFormat is far slower than formatting with one, and a list
// screen formats a date per order. en-GB for Latin digits; the parts are read one by one below,
// so the locale's own separator and order do not matter.
const dayMonthInAppZone = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
});

/**
 * Short English month names, January first. A fixed list rather than Intl's month names: ICU
 * builds differ (some write "Sept"), and the same day must read the same on the server and on
 * every phone.
 */
const ENGLISH_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** A day and month (two-digit strings, month 01-12) in `lang`: "04/11" or "Nov 4". */
function dayMonthIn(lang: Lang, day: string, month: string): string {
  if (lang === 'en') {
    // Number() drops the leading zero ("04" → 4); the month is 01-12, so the index is 0-11.
    const monthName = ENGLISH_MONTHS[Number(month) - 1];
    // Cannot happen: both callers pass a validated month. Fails loudly rather than "undefined 4".
    if (monthName === undefined) throw new RangeError('formatDayMonth: month out of range');
    return `${monthName} ${String(Number(day))}`;
  }
  return `${day}/${month}`;
}

/**
 * A day as the app shows it. Hebrew (the default): "DD/MM", two digits each ("05/01"). English:
 * a short month name and the day without a leading zero, "Jan 5".
 *
 * - A string must be a calendar date `YYYY-MM-DD`, such as `lastMiss.date`: already a day in
 *   Israel, so it is reformatted as text. Never through `new Date(string)`, which reads it as UTC
 *   midnight and shows the previous day in any zone west of UTC.
 * - A `Date` is an instant (`createdAt`), shown as its calendar day in {@link APP_TIME_ZONE}:
 *   23:30 UTC on 11/11 is already 12/11 (Nov 12) in Israel.
 *
 * @throws RangeError for a string that is not a real `YYYY-MM-DD` date, or an invalid `Date`.
 *   The message never contains the value.
 */
export function formatDayMonth(value: string | Date, lang: Lang = 'he'): string {
  if (typeof value === 'string') {
    if (!isoCalendarDateSchema.safeParse(value).success) {
      throw new RangeError('formatDayMonth: expected a calendar date YYYY-MM-DD');
    }
    // `YYYY-MM-DD`: the month is at 5-6, the day at 8-9.
    return dayMonthIn(lang, value.slice(8, 10), value.slice(5, 7));
  }
  if (Number.isNaN(value.getTime())) {
    throw new RangeError('formatDayMonth: invalid Date');
  }
  const parts = dayMonthInAppZone.formatToParts(value);
  const day = parts.find((part) => part.type === 'day')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  // Cannot happen with the options above; checked so a broken Intl fails loudly, not as "undefined".
  if (day === undefined || month === undefined) {
    throw new RangeError('formatDayMonth: Intl gave no day or month');
  }
  return dayMonthIn(lang, day, month);
}

// Sunday first, matching `Date.getUTCDay()`. Fixed lists, like ENGLISH_MONTHS, so the same day
// reads the same on the server and on every phone.
const HEBREW_WEEKDAYS = [
  'יום ראשון',
  'יום שני',
  'יום שלישי',
  'יום רביעי',
  'יום חמישי',
  'יום שישי',
  'שבת',
] as const;
const ENGLISH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * The weekday of a calendar day `YYYY-MM-DD` (a round's date), for the WhatsApp message so the
 * customer sees "11/11 יום רביעי" and not only a number. Hebrew: "יום רביעי" ("שבת" for Saturday,
 * which has no "יום"); English: "Wednesday".
 *
 * The date is already a day in Israel, so the weekday is read from its own calendar fields via UTC
 * (no zone conversion that could shift it by a day).
 *
 * @throws RangeError for a string that is not a real `YYYY-MM-DD` date. The message never contains
 *   the value.
 */
export function formatWeekday(isoDate: string, lang: Lang = 'he'): string {
  if (!isoCalendarDateSchema.safeParse(isoDate).success) {
    throw new RangeError('formatWeekday: expected a calendar date YYYY-MM-DD');
  }
  const index = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  const name = (lang === 'en' ? ENGLISH_WEEKDAYS : HEBREW_WEEKDAYS)[index];
  // Cannot happen: getUTCDay() is 0-6. Fails loudly rather than "undefined".
  if (name === undefined) throw new RangeError('formatWeekday: weekday out of range');
  return name;
}

/**
 * A date and 24-hour time as the collector app shows an order's timestamp (`createdAt`), in
 * {@link APP_TIME_ZONE}: `"DD/MM · HH:MM"`, two digits for every field (e.g. `"12/11 · 08:05"`).
 *
 * @throws RangeError for an invalid `Date`.
 */
export function formatDayMonthTime(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError('formatDayMonthTime: invalid Date');
  }
  const wall = wallClockPartsInAppZone(value);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(wall.day)}/${pad(wall.month)} · ${pad(wall.hour)}:${pad(wall.minute)}`;
}

// ---------------------------------------------------------------------------------------------
// Pickup times (a round's "from" and "by", ADR-0003)
// ---------------------------------------------------------------------------------------------

/**
 * "עד איזו שעה להוציא את הבקבוקים" (ADR-0003): an optional time of the round, `HH:MM` on a 24-hour
 * clock, two digits each (00:00-23:59). Strict, so the message never says "עד השעה 8:0".
 */
export const pickupTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected a time HH:MM, 00:00-23:59');

/**
 * A pickup time ({@link pickupTimeSchema}) as the app shows it. Hebrew: unchanged, a 24-hour
 * "08:00", as Israelis read times. English: a 12-hour clock with AM/PM and no leading zero on the
 * hour: "08:00" → "8:00 AM", "00:30" → "12:30 AM" (midnight is 12 AM), "12:00" → "12:00 PM" (noon),
 * "13:05" → "1:05 PM".
 *
 * Pure text arithmetic, no time zone conversion: a round's times are stored as Israel wall-clock
 * time, so the result is always the time in {@link APP_TIME_ZONE}, wherever the code runs.
 *
 * @throws RangeError when `hhmm` is not a strict `HH:MM`, 00:00-23:59. The message never contains
 *   the value.
 */
export function formatPickupTime(hhmm: string, lang: Lang): string {
  if (!pickupTimeSchema.safeParse(hhmm).success) {
    throw new RangeError('formatPickupTime: expected a time HH:MM, 00:00-23:59');
  }
  if (lang !== 'en') return hhmm;
  const hour24 = Number(hhmm.slice(0, 2));
  const minutes = hhmm.slice(3, 5);
  // 0 → 12 AM, 1-11 → AM, 12 → 12 PM, 13-23 → 1-11 PM.
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(hour12)}:${minutes} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

// ---------------------------------------------------------------------------------------------
// Calendar months (the monthly statistics, spec §3.7)
// ---------------------------------------------------------------------------------------------

/**
 * A calendar month `YYYY-MM`, month 01-12: the `?month=` of GET /api/collector/history and the
 * month picker's value. Exactly four year digits and two month digits, so "2026-1" and "26-10" are
 * refused rather than guessed at.
 */
export const calendarMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

// Built once, like `dayMonthInAppZone`. The full wall-clock time of an instant in Israel: the
// month for `monthInAppZone`, and every field for `appZoneOffsetMs`. `h23` so midnight reads as
// hour 0 (some engines write "24" for it otherwise).
const wallClockInAppZone = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The wall-clock fields of `instant` in {@link APP_TIME_ZONE}, as numbers. */
function wallClockPartsInAppZone(instant: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = wallClockInAppZone.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    // Cannot happen with the options above; checked so a broken Intl fails loudly, not as NaN.
    if (value === undefined) throw new RangeError(`dates: Intl gave no ${type}`);
    return Number(value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * Milliseconds since the epoch of a wall-clock time read as if it were UTC. `setUTCFullYear`
 * rather than `Date.UTC`, which maps the years 0-99 to 1900-1999.
 */
function utcMillisOf(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/**
 * How far Israel's wall clock is ahead of UTC at `instant`, in milliseconds: +2 h in winter (IST),
 * +3 h in summer (IDT).
 */
function appZoneOffsetMs(instant: Date): number {
  const wall = wallClockPartsInAppZone(instant);
  const wallAsUtc = utcMillisOf(
    wall.year,
    wall.month,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // Intl has no milliseconds part: compare whole seconds on both sides.
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Year and month of a `YYYY-MM`, or a RangeError (without the value) when it is not one. */
function parseCalendarMonth(month: string, caller: string): { year: number; month: number } {
  if (!calendarMonthSchema.safeParse(month).success) {
    throw new RangeError(`${caller}: expected a calendar month YYYY-MM`);
  }
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}

/** `YYYY-MM` with a four-digit year and a two-digit month. */
function formatCalendarMonth(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * The calendar month `YYYY-MM` an instant falls in, in {@link APP_TIME_ZONE}: the month an order
 * collected at that instant counts in. 23:30 on 31/10 Israel time (20:30 UTC) is still October;
 * 00:30 on 1/11 Israel time (22:30 UTC on 31/10) is already November.
 *
 * @throws RangeError for an invalid `Date`.
 */
export function monthInAppZone(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('monthInAppZone: invalid Date');
  }
  const wall = wallClockPartsInAppZone(instant);
  return formatCalendarMonth(wall.year, wall.month);
}

/**
 * The instants a calendar month covers in {@link APP_TIME_ZONE}, half-open `[from, to)`: `from` is
 * 00:00 Israel time on the 1st of `month`, `to` is 00:00 Israel time on the 1st of the next month
 * (December rolls into January of the next year). The api filters the month's closed orders with
 * it: `from <= closedAt < to`. '2026-10' is 2026-09-30T21:00Z (IDT, +3) to 2026-10-31T22:00Z
 * (IST, +2: summer time ends on 25/10).
 *
 * @throws RangeError when `month` is not a `YYYY-MM` with a month 01-12. The message never
 *   contains the value.
 */
export function monthRangeInAppZone(month: string): { from: Date; to: Date } {
  const start = parseCalendarMonth(month, 'monthRangeInAppZone');
  const next = parseCalendarMonth(addMonths(month, 1), 'monthRangeInAppZone');
  return {
    from: appZoneMidnightOnFirst(start.year, start.month),
    to: appZoneMidnightOnFirst(next.year, next.month),
  };
}

/**
 * The instant of 00:00 Israel time on the 1st of a month, with no date library: guess that midnight
 * as if it were UTC, read the zone's offset at the guess and step back by it, then read the offset
 * again at the result and correct once more in case the guess sat on the other side of a DST switch.
 *
 * Israel's DST switches happen on a Friday or Sunday night at 02:00, never at midnight on the 1st,
 * so 00:00 on the 1st always exists exactly once (no gap, no repeat); the final check only guards
 * against a future rule change, by failing loudly instead of returning a wrong instant.
 */
function appZoneMidnightOnFirst(year: number, month: number): Date {
  const wallMidnight = utcMillisOf(year, month, 1);
  let instant = wallMidnight - appZoneOffsetMs(new Date(wallMidnight));
  instant = wallMidnight - appZoneOffsetMs(new Date(instant));
  const check = wallClockPartsInAppZone(new Date(instant));
  if (
    check.year !== year ||
    check.month !== month ||
    check.day !== 1 ||
    check.hour !== 0 ||
    check.minute !== 0 ||
    check.second !== 0
  ) {
    throw new RangeError('monthRangeInAppZone: midnight on the 1st does not exist in the zone');
  }
  return new Date(instant);
}

/**
 * A calendar month `YYYY-MM` shifted by whole months, across years: ('2026-01', -1) → '2025-12',
 * ('2026-12', 1) → '2027-01'. The month picker's "previous" and "next".
 *
 * @throws RangeError when `month` is not a `YYYY-MM`, `delta` is not an integer, or the result
 *   leaves the four-digit years 0000-9999.
 */
export function addMonths(month: string, delta: number): string {
  const start = parseCalendarMonth(month, 'addMonths');
  if (!Number.isInteger(delta)) {
    throw new RangeError('addMonths: expected a whole number of months');
  }
  // Months since year 0, so the year carries by plain integer division.
  const monthIndex = start.year * 12 + (start.month - 1) + delta;
  const year = Math.floor(monthIndex / 12);
  if (year < 0 || year > 9999) {
    throw new RangeError('addMonths: the result is outside the years 0000-9999');
  }
  return formatCalendarMonth(year, monthIndex - year * 12 + 1);
}
