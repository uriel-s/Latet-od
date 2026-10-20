import { describe, expect, it } from 'vitest';
import { APP_TIME_ZONE, formatDayMonth } from './dates.ts';

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
