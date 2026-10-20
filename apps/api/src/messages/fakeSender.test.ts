// Tests of FakeSender, the MessageSender other api tests run against: it records copies of what
// it is given, answers with numbered https links by default, and can be told to fail or blow up.
import { messageLogEntrySchema, type OutgoingMessage } from '@bottlerun/shared';
import { describe, expect, it } from 'vitest';
import { FakeSender } from './fakeSender.ts';

const LINK = 'https://latet-od.test/o/Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';

/** A confirmation request for the round of 5 November, with overrides on top. */
function makeMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    kind: 'confirmRequest',
    orderId: '6710f3a2c4b5d6e7f8a9b0c1',
    to: '+972501234567',
    vars: { name: 'משה כהן', link: LINK, date: '2026-11-05' },
    ...overrides,
  };
}

describe('FakeSender', () => {
  it('records every message, in order', async () => {
    const sender = new FakeSender();
    const first = makeMessage();
    const second = makeMessage({ kind: 'thankYou', orderId: '6710f3a2c4b5d6e7f8a9b0c2' });

    await sender.send(first);
    await sender.send(second);

    expect(sender.sent).toEqual([first, second]);
  });

  it('records a copy, which a later change to the message does not touch', async () => {
    const sender = new FakeSender();
    const message = makeMessage();

    await sender.send(message);
    message.vars.name = 'שם אחר';

    expect(sender.sent[0]).not.toBe(message);
    expect(sender.sent[0]?.vars.name).toBe('משה כהן');
  });

  it('answers with manual https links numbered 1, 2, …', async () => {
    const sender = new FakeSender();

    const results = [await sender.send(makeMessage()), await sender.send(makeMessage())];

    expect(results).toEqual([
      { mode: 'manual', url: 'https://fake-sender.test/1' },
      { mode: 'manual', url: 'https://fake-sender.test/2' },
    ]);
    for (const result of results) {
      const entry = { kind: 'confirmRequest', at: new Date(), ...result };
      expect(messageLogEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('numbers its links per instance', async () => {
    await new FakeSender().send(makeMessage());

    await expect(new FakeSender().send(makeMessage())).resolves.toEqual({
      mode: 'manual',
      url: 'https://fake-sender.test/1',
    });
  });

  it('answers with what a custom respond returns, given the message', async () => {
    const seen: OutgoingMessage[] = [];
    const sender = new FakeSender((message) => {
      seen.push(message);
      return { mode: 'failed', reason: 'test_failure' };
    });
    const message = makeMessage();

    await expect(sender.send(message)).resolves.toEqual({
      mode: 'failed',
      reason: 'test_failure',
    });
    expect(seen).toEqual([message]);
  });

  it('waits for a custom respond that returns a promise', async () => {
    const sender = new FakeSender(() => Promise.resolve({ mode: 'sent', providerId: 'wamid.1' }));

    await expect(sender.send(makeMessage())).resolves.toEqual({
      mode: 'sent',
      providerId: 'wamid.1',
    });
  });

  it('rejects when respond throws, and still records the message', async () => {
    const sender = new FakeSender(() => {
      throw new Error('sender blew up');
    });

    await expect(sender.send(makeMessage())).rejects.toThrow('sender blew up');
    expect(sender.sent).toHaveLength(1);
  });

  it('rejects when respond rejects', async () => {
    const sender = new FakeSender(() => Promise.reject(new Error('provider down')));

    await expect(sender.send(makeMessage())).rejects.toThrow('provider down');
  });
});
