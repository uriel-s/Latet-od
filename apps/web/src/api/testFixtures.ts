// Test-only: the collector's order that both collectorOrdersApi.test.ts and roundsApi.test.ts
// send and expect back, and an id that must be encoded in a path.
import type { CollectorOrder } from '@bottlerun/shared';

/**
 * One order as Yoel's screens get it. The fake fetch's JSON.stringify writes `createdAt` as the
 * ISO string the api sends, so a parsed answer equal to this one has turned it back into a Date.
 */
export const ORDER: CollectorOrder = {
  id: '6710f3a2c4b5d6e7f8a9b0c1',
  contact: { name: 'משה כהן', phone: '+972501234567' },
  address: {
    streetCode: 247,
    streetName: 'דרך רבין יצחק',
    houseNumber: '12א',
    bottlesSpot: 'apartmentDoor',
    floorApt: 'קומה 3, דירה 12',
  },
  bottlesEstimated: 45,
  status: 'waiting',
  region: 'ramat',
  lastMiss: { date: '2026-10-12', reason: 'notConfirmed', roundId: 'round-0' },
  source: 'collector',
  createdAt: new Date('2026-10-19T08:30:00.000Z'),
  hasLocation: true,
};

/** An id that is not a path segment as it is: its `/`, `?` and `#` must be encoded. */
export const ODD_ID = 'a/b?c#d';
export const ODD_ID_IN_PATH = 'a%2Fb%3Fc%23d';
