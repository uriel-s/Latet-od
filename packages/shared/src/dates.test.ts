import { describe, expect, it } from 'vitest';
import {
  APP_TIME_ZONE,
  addMonths,
  calendarMonthSchema,
  formatDayMonth,
  monthInAppZone,
  monthRangeInAppZone,
} from './dates.ts';

describe('APP_TIME_ZONE', () => {
  it('is Israel', () => {
    expect(APP_TIME_ZONE).toBe('Asia/Jerusalem');
  });
});

describe('formatDayMonth', () => {
  describe('with a calendar date string', () => {
    it('reformats YYYY-MM-DD as DD/MM', () => {
      expect(formatDayMonth('2026-11-12')).toBe('12/11');
    });

    it('keeps two digits for a single-digit day and month', () => {
      expect(formatDayMonth('2026-01-05')).toBe('05/01');
    });

    it('accepts 29 February of a leap year', () => {
      expect(formatDayMonth('2028-02-29')).toBe('29/02');
    });

    it('throws a RangeError for anything that is not a real YYYY-MM-DD date', () => {
      const notDates = [
        '',
        '12/11',
        '2026-11-12T10:00:00Z',
        '2026-1-5',
        '26-11-12',
        ' 2026-11-12',
        '2026-13-01',
        '2026-02-30',
        '2027-02-29',
      ];
      for (const value of notDates) {
        expect(() => formatDayMonth(value), value).toThrow(RangeError);
      }
    });

    it('leaves the value out of the error message', () => {
      let message: string | undefined;
      try {
        formatDayMonth('2026-13-01');
      } catch (error) {
        message = error instanceof Error ? error.message : undefined;
      }
      expect(message).toBeTypeOf('string');
      expect(message).not.toContain('2026-13-01');
    });
  });

  describe('with a Date', () => {
    it('shows the day in Israel in winter (UTC+2), not the UTC day', () => {
      expect(formatDayMonth(new Date('2026-11-11T23:30:00Z'))).toBe('12/11');
    });

    it('shows the day in Israel in summer (UTC+3), not the UTC day', () => {
      expect(formatDayMonth(new Date('2026-07-01T21:30:00Z'))).toBe('02/07');
    });

    it('keeps the same day before Israeli midnight', () => {
      expect(formatDayMonth(new Date('2026-07-01T20:30:00Z'))).toBe('01/07');
    });

    it('throws a RangeError for an invalid Date', () => {
      expect(() => formatDayMonth(new Date('not a date'))).toThrow(RangeError);
    });
  });
});

/** Values that are not a `YYYY-MM` with a month 01-12. */
const NOT_MONTHS = [
  '',
  '2026-13',
  '2026-00',
  '2026-1',
  '26-10',
  '2026-10-01',
  ' 2026-10',
  '2026/10',
];

/** The message of the error `run` throws, or undefined when it throws none. */
function errorMessageOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : undefined;
  }
  return undefined;
}

describe('calendarMonthSchema', () => {
  it('accepts YYYY-MM with a month 01-12', () => {
    for (const month of ['2026-01', '2026-10', '2026-12', '1999-07']) {
      expect(calendarMonthSchema.safeParse(month).success, month).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const value of [...NOT_MONTHS, 202610, undefined, ['2026-10']]) {
      expect(calendarMonthSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe('monthInAppZone', () => {
  it('counts 23:30 on 31/10 Israel time (winter, UTC+2) in October', () => {
    expect(monthInAppZone(new Date('2026-10-31T20:30:00Z'))).toBe('2026-10');
    expect(monthInAppZone(new Date('2026-10-31T21:59:59Z'))).toBe('2026-10');
  });

  it('counts 00:30 on 1/11 Israel time in November although it is still October in UTC', () => {
    expect(monthInAppZone(new Date('2026-10-31T22:30:00Z'))).toBe('2026-11');
  });

  it('starts the month at Israeli midnight in summer (UTC+3)', () => {
    expect(monthInAppZone(new Date('2026-06-30T20:59:59Z'))).toBe('2026-06');
    expect(monthInAppZone(new Date('2026-06-30T21:00:00Z'))).toBe('2026-07');
  });

  it('rolls 1/1 Israel time into the new year', () => {
    expect(monthInAppZone(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01');
  });

  it('throws a RangeError for an invalid Date', () => {
    expect(() => monthInAppZone(new Date('not a date'))).toThrow(RangeError);
  });
});

describe('monthRangeInAppZone', () => {
  it('covers a summer month from and to midnight at UTC+3', () => {
    const range = monthRangeInAppZone('2026-07');
    expect(range.from.toISOString()).toBe('2026-06-30T21:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-07-31T21:00:00.000Z');
  });

  it('covers a winter month from and to midnight at UTC+2', () => {
    const range = monthRangeInAppZone('2026-01');
    expect(range.from.toISOString()).toBe('2025-12-31T22:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-01-31T22:00:00.000Z');
  });

  it('starts October 2026 at UTC+3 and ends it at UTC+2 (summer time ends on 25/10)', () => {
    const range = monthRangeInAppZone('2026-10');
    expect(range.from.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-31T22:00:00.000Z');
  });

  it('starts March 2026 at UTC+2 and ends it at UTC+3 (summer time starts on 27/3)', () => {
    const range = monthRangeInAppZone('2026-03');
    expect(range.from.toISOString()).toBe('2026-02-28T22:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-03-31T21:00:00.000Z');
  });

  it('rolls December into January of the next year', () => {
    const range = monthRangeInAppZone('2026-12');
    expect(range.from.toISOString()).toBe('2026-11-30T22:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-12-31T22:00:00.000Z');
  });

  it('agrees with monthInAppZone at both edges', () => {
    const range = monthRangeInAppZone('2026-10');
    expect(monthInAppZone(range.from)).toBe('2026-10');
    expect(monthInAppZone(new Date(range.from.getTime() - 1))).toBe('2026-09');
    expect(monthInAppZone(range.to)).toBe('2026-11');
    expect(monthInAppZone(new Date(range.to.getTime() - 1))).toBe('2026-10');
  });

  it('throws a RangeError for anything that is not a calendar month', () => {
    for (const value of NOT_MONTHS) {
      expect(() => monthRangeInAppZone(value), value).toThrow(RangeError);
    }
  });

  it('leaves the value out of the error message', () => {
    const message = errorMessageOf(() => monthRangeInAppZone('2026-13'));
    expect(message).toBeTypeOf('string');
    expect(message).not.toContain('2026-13');
  });
});

describe('addMonths', () => {
  it('shifts within a year', () => {
    expect(addMonths('2026-10', 1)).toBe('2026-11');
    expect(addMonths('2026-10', -1)).toBe('2026-09');
    expect(addMonths('2026-10', 0)).toBe('2026-10');
  });

  it('shifts across years in both directions', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-10', -22)).toBe('2024-12');
    expect(addMonths('2026-10', 15)).toBe('2028-01');
  });

  it('throws a RangeError for an invalid month', () => {
    for (const value of NOT_MONTHS) {
      expect(() => addMonths(value, 1), value).toThrow(RangeError);
    }
  });

  it('throws a RangeError for a delta that is not a whole number', () => {
    for (const delta of [0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => addMonths('2026-10', delta), String(delta)).toThrow(RangeError);
    }
  });

  it('throws a RangeError when the result leaves the four-digit years', () => {
    expect(() => addMonths('9999-12', 1)).toThrow(RangeError);
    expect(() => addMonths('0000-01', -1)).toThrow(RangeError);
  });
});
