import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findStreet, type OrderSummary } from '@bottlerun/shared';
import { validateOrderForm } from './formValues.ts';
import {
  SAVED_DETAILS_KEY,
  formValuesFromPrefill,
  loadSavedDetails,
  orderFormNavigationState,
  prefillFromNavigationState,
  saveDetails,
  type OrderPrefill,
} from './savedDetails.ts';

/** A returning customer's details, as the 201 answer's summary holds them, with `overrides`. */
function makePrefill(overrides: Partial<OrderPrefill['address']> = {}): OrderPrefill {
  return {
    contact: { name: 'משה כהן', phone: '+972501234567' },
    address: {
      streetCode: 247,
      streetName: 'דרך רבין יצחק',
      houseNumber: '12א',
      bottlesSpot: 'privateHouse',
      ...overrides,
    },
  };
}

/** An in-memory Storage, like a browser's localStorage. */
class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** A storage that refuses every access, like blocked or full storage in some private modes. */
const BLOCKED_STORAGE = {
  getItem(): string | null {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
  setItem(): void {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  },
};

describe('saveDetails and loadSavedDetails', () => {
  it('load what was saved', () => {
    const storage = new MemoryStorage();

    saveDetails(makePrefill(), storage);

    expect(loadSavedDetails(storage)).toEqual(makePrefill());
  });

  it('load null when nothing was saved', () => {
    expect(loadSavedDetails(new MemoryStorage())).toBeNull();
  });

  it('store contact and address only, never the number of bottles', () => {
    const storage = new MemoryStorage();
    const summary: OrderSummary = { ...makePrefill(), bottlesEstimated: 45 };

    saveDetails(summary, storage);

    const stored = JSON.parse(storage.items.get(SAVED_DETAILS_KEY) ?? 'null') as unknown;
    expect(stored).toEqual(makePrefill());
    expect(stored).not.toHaveProperty('bottlesEstimated');
  });

  it('save nothing for details that do not parse', () => {
    const storage = new MemoryStorage();

    saveDetails({ ...makePrefill(), contact: { name: 'משה', phone: '050-1234567' } }, storage);

    expect(storage.items.size).toBe(0);
  });

  it('load null for corrupt JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(SAVED_DETAILS_KEY, '{"contact": ');

    expect(loadSavedDetails(storage)).toBeNull();
  });

  it('load null for a shape the schema does not accept', () => {
    for (const saved of [
      { name: 'משה', phone: '0501234567' },
      { contact: { name: 'משה', phone: '0501234567' }, address: makePrefill().address },
      { contact: makePrefill().contact },
      'משה',
      null,
    ]) {
      const storage = new MemoryStorage();
      storage.setItem(SAVED_DETAILS_KEY, JSON.stringify(saved));
      expect(loadSavedDetails(storage), JSON.stringify(saved)).toBeNull();
    }
  });

  it('load null and save silently when storage refuses access', () => {
    expect(loadSavedDetails(BLOCKED_STORAGE)).toBeNull();
    expect(() => saveDetails(makePrefill(), BLOCKED_STORAGE)).not.toThrow();
  });
});

describe('saveDetails and loadSavedDetails with the browser localStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('use window.localStorage by default', () => {
    saveDetails(makePrefill());

    expect(window.localStorage.getItem(SAVED_DETAILS_KEY)).not.toBeNull();
    expect(loadSavedDetails()).toEqual(makePrefill());
  });

  it('load null and save silently when even reading window.localStorage throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(loadSavedDetails()).toBeNull();
    expect(() => saveDetails(makePrefill())).not.toThrow();
  });
});

describe('orderFormNavigationState and prefillFromNavigationState', () => {
  it('read back the prefill the state was made with', () => {
    expect(prefillFromNavigationState(orderFormNavigationState(makePrefill()))).toEqual(
      makePrefill(),
    );
  });

  it('read back the prefill after the browser stores the state (structured clone)', () => {
    const state = structuredClone(orderFormNavigationState(makePrefill()));

    expect(prefillFromNavigationState(state)).toEqual(makePrefill());
  });

  it('read null from any other state', () => {
    for (const state of [
      undefined,
      null,
      'orderPrefill',
      42,
      {},
      { other: makePrefill() },
      { orderPrefill: null },
      { orderPrefill: { contact: makePrefill().contact } },
      { orderPrefill: { ...makePrefill(), contact: { name: 'משה', phone: '050-1234567' } } },
    ]) {
      expect(prefillFromNavigationState(state), JSON.stringify(state)).toBeNull();
    }
  });

  it('read the prefill without the number of bottles when a whole summary was passed', () => {
    const summary: OrderSummary = { ...makePrefill(), bottlesEstimated: 45 };
    const state = orderFormNavigationState(summary);

    expect(prefillFromNavigationState(state)).not.toHaveProperty('bottlesEstimated');
  });
});

describe('formValuesFromPrefill', () => {
  it('fills a listed street, the phone in local form, and leaves bottles and honeypot empty', () => {
    expect(formValuesFromPrefill(makePrefill())).toEqual({
      name: 'משה כהן',
      phone: '050-1234567',
      street: { kind: 'listed', code: 247, name: 'דרך רבין יצחק' },
      houseNumber: '12א',
      bottlesSpot: 'privateHouse',
      floorApt: '',
      note: '',
      bottlesEstimated: '',
      website: '',
    });
  });

  it('takes the current official name of a listed street, not the stored one', () => {
    const values = formValuesFromPrefill(makePrefill({ streetName: 'רבין' }));

    expect(values.street).toEqual({ kind: 'listed', code: 247, name: 'דרך רבין יצחק' });
  });

  it('fills a street written by hand as free text', () => {
    const prefill = makePrefill({ streetName: 'הנרקיס' });
    delete prefill.address.streetCode;

    expect(formValuesFromPrefill(prefill).street).toEqual({ kind: 'freeText', name: 'הנרקיס' });
  });

  it('fills a street whose code is no longer in the list as free text with its stored name', () => {
    const unknownCode = 999_999;
    expect(findStreet(unknownCode)).toBeUndefined();

    const values = formValuesFromPrefill(
      makePrefill({ streetCode: unknownCode, streetName: 'רחוב שנמחק' }),
    );

    expect(values.street).toEqual({ kind: 'freeText', name: 'רחוב שנמחק' });
  });

  it('fills the floor and apartment and the note when the prefill has them', () => {
    const values = formValuesFromPrefill(
      makePrefill({ bottlesSpot: 'apartmentDoor', floorApt: 'קומה 3, דירה 12', note: 'קוד 1234' }),
    );

    expect(values.bottlesSpot).toBe('apartmentDoor');
    expect(values.floorApt).toBe('קומה 3, דירה 12');
    expect(values.note).toBe('קוד 1234');
  });

  it('gives values that validate to the same contact and address once bottles are typed', () => {
    const prefill = makePrefill({ bottlesSpot: 'apartmentDoor', floorApt: 'קומה 3' });

    const result = validateOrderForm({ ...formValuesFromPrefill(prefill), bottlesEstimated: '40' });

    expect(result).toEqual({
      ok: true,
      request: { ...prefill, bottlesEstimated: 40, website: '' },
    });
  });
});
