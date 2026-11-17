import { describe, expect, it } from 'vitest';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import { planErrorsOf } from './planErrors.ts';

describe('planErrorsOf', () => {
  it('puts an error on one id of the list on the list', () => {
    expect(planErrorsOf({ 'orderIds.3': 'לא תקין' })).toEqual({
      byField: { orderIds: 'לא תקין' },
    });
  });

  it('sets other for a path no field shows', () => {
    expect(planErrorsOf({ date: 'חסר תאריך', round: 'לא תקין' })).toEqual({
      byField: { date: 'חסר תאריך' },
      other: UNKNOWN_FIELD_ERROR,
    });
  });
});
