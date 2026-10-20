// Runs the OrdersRepo contract on the in-memory fake, which proves the fake that every other api
// test uses behaves like a real orders repository.
import { describe, expect, it } from 'vitest';
import { InMemoryOrdersRepo } from './inMemoryOrdersRepo.ts';
import { makeNewOrder } from './makeOrder.ts';
import { describeOrdersRepoContract } from './ordersRepo.contract.ts';

describeOrdersRepoContract('InMemoryOrdersRepo', () => new InMemoryOrdersRepo());

describe('InMemoryOrdersRepo', () => {
  it('issues ids shaped like a Mongo ObjectId', async () => {
    const created = await new InMemoryOrdersRepo().create(makeNewOrder());

    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('shares nothing between instances', async () => {
    const created = await new InMemoryOrdersRepo().create(makeNewOrder());

    expect(await new InMemoryOrdersRepo().findById(created.id)).toBeNull();
  });
});
