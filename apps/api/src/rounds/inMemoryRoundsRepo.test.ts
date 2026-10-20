// Runs the RoundsRepo contract on the in-memory fake, which proves the fake that every other api
// test uses behaves like a real rounds repository.
import { describe, expect, it } from 'vitest';
import { InMemoryRoundsRepo } from './inMemoryRoundsRepo.ts';
import { makeNewRound } from './makeRound.ts';
import { describeRoundsRepoContract } from './roundsRepo.contract.ts';

describeRoundsRepoContract('InMemoryRoundsRepo', () => new InMemoryRoundsRepo());

describe('InMemoryRoundsRepo', () => {
  it('issues ids shaped like a Mongo ObjectId', async () => {
    const created = await new InMemoryRoundsRepo().create(makeNewRound());

    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('shares nothing between instances', async () => {
    const created = await new InMemoryRoundsRepo().create(makeNewRound());

    expect(await new InMemoryRoundsRepo().findById(created.id)).toBeNull();
  });
});
