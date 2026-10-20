import { describe, expect, it } from 'vitest';
import type { LastMiss, MissReason } from '@bottlerun/shared';
import { NO_LOCATION_TAG, lastMissTag, orderTags } from './orderTags.ts';

/** A last miss on 12/11 for `reason`, in round r1. */
function missOn12November(reason: MissReason): LastMiss {
  return { date: '2026-11-12', reason, roundId: 'r1' };
}

describe('lastMissTag', () => {
  it.each<[MissReason, string]>([
    ['notConfirmed', 'לא אישר בזמן · 12/11'],
    ['askedOtherDate', 'ביקש מועד אחר · 12/11'],
    ['notFound', 'לא נמצא במקום · 12/11'],
    ['notReached', 'לא הגענו אליו · 12/11'],
    ['addressChanged', 'שינה כתובת · 12/11'],
  ])('shows the reason %s in words with the day as DD/MM', (reason, expected) => {
    expect(lastMissTag(missOn12November(reason))).toBe(expected);
  });

  it('pads a one-digit day and month to two digits', () => {
    expect(lastMissTag({ date: '2027-01-05', reason: 'notReached', roundId: 'r2' })).toBe(
      'לא הגענו אליו · 05/01',
    );
  });
});

describe('orderTags', () => {
  it('has no tags for an order with a location and no miss', () => {
    expect(orderTags({ hasLocation: true })).toEqual([]);
  });

  it('has only the miss tag for an order back from a round that has a location', () => {
    expect(orderTags({ hasLocation: true, lastMiss: missOn12November('notConfirmed') })).toEqual([
      'לא אישר בזמן · 12/11',
    ]);
  });

  it('has only "בלי מיקום" for an order without a location and no miss', () => {
    expect(NO_LOCATION_TAG).toBe('בלי מיקום');
    expect(orderTags({ hasLocation: false })).toEqual(['בלי מיקום']);
  });

  it('puts the miss tag first and "בלי מיקום" second when both apply', () => {
    expect(orderTags({ hasLocation: false, lastMiss: missOn12November('addressChanged') })).toEqual(
      ['שינה כתובת · 12/11', 'בלי מיקום'],
    );
  });
});
