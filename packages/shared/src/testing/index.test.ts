import { describe, expect, it } from 'vitest';
import { STREETS } from '../streets.ts';
import { deferred, firstRealStreet } from './index.ts';

describe('deferred', () => {
  it('stays pending until the test resolves it, then gives the value', async () => {
    const { promise, resolve } = deferred<string>();
    let settledWith: string | undefined;
    void promise.then((value) => {
      settledWith = value;
    });

    await Promise.resolve();
    expect(settledWith).toBeUndefined();

    resolve('done');
    await expect(promise).resolves.toBe('done');
    expect(settledWith).toBe('done');
  });
});

describe('firstRealStreet', () => {
  it('returns the first street of the real list that matches', () => {
    const ramat = firstRealStreet((street) => street.region === 'ramat');

    expect(ramat).toBe(STREETS.find((street) => street.region === 'ramat'));
    expect(ramat.region).toBe('ramat');
  });

  it('throws when no street matches', () => {
    expect(() => firstRealStreet(() => false)).toThrow('no street in data/streets.json matches');
  });
});
