// Unit tests of MongoAttemptStore's pure parts: the stored document, the window query and the
// index specs. No test connects to a database (the contract suite runs on Atlas only by hand).
import { describe, expect, it } from 'vitest';
import { ATTEMPT_INDEXES, attemptDocument, inWindowFilter } from './mongoAttemptStore.ts';

const NOW = new Date('2026-10-19T08:30:00.000Z');
const WINDOW_MS = 15 * 60_000;

describe('attemptDocument', () => {
  it('records the key and the time, and expires when the window has passed', () => {
    expect(attemptDocument('login:ip:1.2.3.4', NOW, WINDOW_MS)).toEqual({
      key: 'login:ip:1.2.3.4',
      at: NOW,
      expiresAt: new Date('2026-10-19T08:45:00.000Z'),
    });
  });

  it('keeps its own copy of the time', () => {
    const now = new Date(NOW);
    const doc = attemptDocument('login:all', now, WINDOW_MS);

    now.setTime(0);

    expect(doc.at).toEqual(NOW);
  });
});

describe('inWindowFilter', () => {
  it('counts attempts of the key made after now minus the window', () => {
    expect(inWindowFilter('order:ip:1.2.3.4', NOW, WINDOW_MS)).toEqual({
      key: { $eq: 'order:ip:1.2.3.4' },
      // $gt, not $gte: an attempt exactly windowMs old no longer counts.
      at: { $gt: new Date('2026-10-19T08:15:00.000Z') },
    });
  });
});

describe('ATTEMPT_INDEXES', () => {
  it('lets Mongo delete each attempt at its own expiresAt', () => {
    expect(ATTEMPT_INDEXES).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
  });

  it('indexes the count by key and time', () => {
    expect(ATTEMPT_INDEXES).toContainEqual(expect.objectContaining({ key: { key: 1, at: 1 } }));
  });
});
