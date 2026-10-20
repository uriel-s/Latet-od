// Calendar dates as the app shows them: DD/MM, in Israel's time zone (spec §7, CLAUDE.md). Shared
// so the collector app's tags ("לא אישר · 12/11") and anything the api writes read a day the same
// way, whatever zone the code runs in (UTC on Vercel, the phone's own zone in the browser).
import { z } from 'zod';

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
 * A day as the app shows it: "DD/MM", two digits each ("05/01").
 *
 * - A string must be a calendar date `YYYY-MM-DD`, such as `lastMiss.date`: already a day in
 *   Israel, so it is reformatted as text. Never through `new Date(string)`, which reads it as UTC
 *   midnight and shows the previous day in any zone west of UTC.
 * - A `Date` is an instant (`createdAt`), shown as its calendar day in {@link APP_TIME_ZONE}:
 *   23:30 UTC on 11/11 is already 12/11 in Israel.
 *
 * @throws RangeError for a string that is not a real `YYYY-MM-DD` date, or an invalid `Date`.
 *   The message never contains the value.
 */
export function formatDayMonth(value: string | Date): string {
  if (typeof value === 'string') {
    if (!isoCalendarDateSchema.safeParse(value).success) {
      throw new RangeError('formatDayMonth: expected a calendar date YYYY-MM-DD');
    }
    // `YYYY-MM-DD`: the month is at 5-6, the day at 8-9.
    return `${value.slice(8, 10)}/${value.slice(5, 7)}`;
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
  return `${day}/${month}`;
}
