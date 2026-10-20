import { describe, expect, it } from 'vitest';
import {
  PHONE_ERROR,
  e164MobileSchema,
  formatIsraeliMobileLocal,
  israeliMobileSchema,
  normalizeIsraeliMobile,
} from './phone.ts';

const E164 = '+972501234567';

describe('normalizeIsraeliMobile', () => {
  it('normalizes the local 10-digit form to E.164', () => {
    expect(normalizeIsraeliMobile('0501234567')).toBe(E164);
  });

  it('accepts any 05X prefix', () => {
    expect(normalizeIsraeliMobile('0521234567')).toBe('+972521234567');
    expect(normalizeIsraeliMobile('0581234567')).toBe('+972581234567');
  });

  it('ignores spaces, hyphens, dots and parentheses anywhere', () => {
    for (const input of [
      '050-1234567',
      '050-123-4567',
      '050 123 4567',
      '  050 1234567  ',
      '050.123.4567',
      '(050) 123-4567',
      '0 5 0 - 1 2 3 4 5 6 7',
    ]) {
      expect(normalizeIsraeliMobile(input), input).toBe(E164);
    }
  });

  it('ignores a no-break space, a typographic dash and the direction marks of copied Hebrew text', () => {
    expect(normalizeIsraeliMobile('050\u{00a0}1234567')).toBe(E164);
    expect(normalizeIsraeliMobile('050\u{2013}1234567')).toBe(E164);
    expect(normalizeIsraeliMobile('\u{200e}050-1234567\u{200f}')).toBe(E164);
    expect(normalizeIsraeliMobile('\u{202a}050-1234567\u{202c}')).toBe(E164);
  });

  it('accepts the international forms +972, 00972 and 972', () => {
    for (const input of ['+972501234567', '+972 50-123-4567', '00972501234567', '972501234567']) {
      expect(normalizeIsraeliMobile(input), input).toBe(E164);
    }
  });

  it('accepts the trunk 0 kept after the country code', () => {
    for (const input of [
      '+972 050-123-4567',
      '+9720501234567',
      '+972 (0)50 123 4567',
      '9720501234567',
    ]) {
      expect(normalizeIsraeliMobile(input), input).toBe(E164);
    }
  });

  it('rejects landlines', () => {
    for (const input of [
      '02-9912345',
      '08-9912345',
      '03-1234567',
      '+972 2-991-2345',
      '+97289912345',
    ]) {
      expect(normalizeIsraeliMobile(input), input).toBeNull();
    }
  });

  it('rejects a 07X number, which is not mobile', () => {
    expect(normalizeIsraeliMobile('0771234567')).toBeNull();
  });

  it('rejects 9 and 11 digits', () => {
    expect(normalizeIsraeliMobile('050123456')).toBeNull();
    expect(normalizeIsraeliMobile('05012345678')).toBeNull();
    expect(normalizeIsraeliMobile('+97250123456')).toBeNull();
    expect(normalizeIsraeliMobile('+9725012345678')).toBeNull();
  });

  it('rejects a number without the trunk 0 or the country code', () => {
    expect(normalizeIsraeliMobile('501234567')).toBeNull();
  });

  it('rejects letters', () => {
    expect(normalizeIsraeliMobile('050-123456a')).toBeNull();
    expect(normalizeIsraeliMobile('טלפון')).toBeNull();
  });

  it('rejects a + anywhere but the start, and a foreign country code', () => {
    expect(normalizeIsraeliMobile('050+1234567')).toBeNull();
    expect(normalizeIsraeliMobile('++972501234567')).toBeNull();
    expect(normalizeIsraeliMobile('+1 501234567')).toBeNull();
  });

  it('rejects an empty or blank string', () => {
    expect(normalizeIsraeliMobile('')).toBeNull();
    expect(normalizeIsraeliMobile('   ')).toBeNull();
    expect(normalizeIsraeliMobile('--')).toBeNull();
  });
});

describe('israeliMobileSchema', () => {
  it('outputs the E.164 number for what the customer typed', () => {
    expect(israeliMobileSchema.parse(' 050-123-4567 ')).toBe(E164);
    expect(israeliMobileSchema.parse('+972 50 123 4567')).toBe(E164);
  });

  it('fails with one plain Hebrew message for an invalid number', () => {
    const result = israeliMobileSchema.safeParse('02-9912345');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toBe(PHONE_ERROR);
  });

  it('fails with the same Hebrew message for an empty string', () => {
    const result = israeliMobileSchema.safeParse('');
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([PHONE_ERROR]);
  });

  it('fails with the same Hebrew message when the field is missing or not a string', () => {
    for (const input of [undefined, null, 501234567]) {
      const result = israeliMobileSchema.safeParse(input);
      expect(
        result.error?.issues.map((issue) => issue.message),
        String(input),
      ).toEqual([PHONE_ERROR]);
    }
  });
});

describe('e164MobileSchema', () => {
  it('accepts a stored E.164 mobile number', () => {
    expect(e164MobileSchema.parse(E164)).toBe(E164);
  });

  it('rejects anything not already normalized', () => {
    for (const input of ['0501234567', '972501234567', '+972 50 123 4567', '+97221234567', '']) {
      expect(e164MobileSchema.safeParse(input).success, input).toBe(false);
    }
  });

  it('accepts every number normalizeIsraeliMobile outputs', () => {
    for (const input of ['050-1234567', '00972 52 765 4321', '+972 058-111-2222']) {
      const e164 = normalizeIsraeliMobile(input);
      expect(e164MobileSchema.safeParse(e164).success, input).toBe(true);
    }
  });
});

describe('formatIsraeliMobileLocal', () => {
  it('turns a stored E.164 mobile into the local form customers know', () => {
    expect(formatIsraeliMobileLocal(E164)).toBe('050-1234567');
  });

  it('keeps every 05X prefix', () => {
    expect(formatIsraeliMobileLocal('+972521234567')).toBe('052-1234567');
    expect(formatIsraeliMobileLocal('+972587654321')).toBe('058-7654321');
  });

  it('outputs a number that normalizes back to the same E.164 number', () => {
    for (const e164 of [E164, '+972521234567', '+972549876543']) {
      expect(normalizeIsraeliMobile(formatIsraeliMobileLocal(e164)), e164).toBe(e164);
    }
  });

  it('returns anything that is not an E.164 Israeli mobile unchanged', () => {
    for (const input of [
      '0501234567',
      '050-1234567',
      '+972 50 123 4567',
      '972501234567',
      '+97221234567',
      '+9725012345678',
      '',
      'טלפון',
    ]) {
      expect(formatIsraeliMobileLocal(input), input).toBe(input);
    }
  });
});
