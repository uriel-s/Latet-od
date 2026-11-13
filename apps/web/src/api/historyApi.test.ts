import { describe, expect, it } from 'vitest';
import type { HistoryResponse } from '@bottlerun/shared';
import { makeFakeFetch } from './fakeFetch.ts';
import { fetchHistory } from './historyApi.ts';
import { describeEveryEndpoint } from './request.contract.ts';

/** October 2026: one collected order and one cancelled one, newest first. */
const HISTORY: HistoryResponse = {
  month: '2026-10',
  totals: { bottlesCollected: 45, addressesCollected: 1, valueAgorot: 900 },
  orders: [
    {
      id: 'o2',
      status: 'cancelled',
      contact: { name: 'משה לוי' },
      address: { streetName: 'הרצל', houseNumber: '5' },
      bottlesEstimated: 40,
      closedAt: new Date('2026-10-20T09:00:00.000Z'),
    },
    {
      id: 'o1',
      status: 'collected',
      contact: { name: 'דנה כהן' },
      address: { streetName: 'שד נהר הדן', houseNumber: '12' },
      bottlesEstimated: 40,
      bottlesCollected: 45,
      closedAt: new Date('2026-10-12T07:30:00.000Z'),
    },
  ],
};

describe('fetchHistory', () => {
  it('asks GET /api/collector/history with the month, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: HISTORY });

    await fetchHistory('2026-10', fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/history?month=2026-10');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('encodes the month, so it stays one query value', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 400, body: { error: 'invalid_month' } });

    await fetchHistory('2026-10&month=2026-11', fetchFn);

    expect(calls[0]?.input).toBe('/api/collector/history?month=2026-10%26month%3D2026-11');
  });

  it('answers loaded with the totals and the closed orders on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: HISTORY });

    const outcome = await fetchHistory('2026-10', fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', history: HISTORY });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.history.orders[0]?.closedAt).toBeInstanceOf(Date);
  });

  it('answers loaded for a month with nothing closed', async () => {
    const empty: HistoryResponse = {
      month: '2026-09',
      totals: { bottlesCollected: 0, addressesCollected: 0, valueAgorot: 0 },
      orders: [],
    };
    const { fetchFn } = makeFakeFetch({ status: 200, body: empty });

    expect(await fetchHistory('2026-09', fetchFn)).toEqual({ kind: 'loaded', history: empty });
  });

  it('answers failed on a 200 whose body is not a history', async () => {
    const [firstOrder] = HISTORY.orders;
    for (const answer of [
      { status: 200, body: { ...HISTORY, month: '2026-13' } },
      { status: 200, body: { ...HISTORY, totals: { ...HISTORY.totals, valueAgorot: -1 } } },
      { status: 200, body: { ...HISTORY, orders: [{ ...firstOrder, status: 'waiting' }] } },
      { status: 200, body: { ...HISTORY, orders: [{ ...firstOrder, closedAt: 'yesterday' }] } },
      { status: 200, body: { totals: HISTORY.totals, orders: [] } },
      { status: 200, body: [] },
      { status: 200, text: '<html>ok</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchHistory('2026-10', fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });
});

describeEveryEndpoint([
  {
    name: 'fetchHistory',
    call: (fetchFn) => fetchHistory('2026-10', fetchFn),
    success: { status: 200, body: HISTORY },
    on401: 'loggedOut',
    // A 400 too: the picker only builds valid months, so `invalid_month` is a client bug.
    alsoFailed: [201, 400, 404, 429],
    failedBody: { error: 'invalid_month' },
  },
]);
