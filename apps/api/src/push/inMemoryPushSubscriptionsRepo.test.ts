// Runs the PushSubscriptionsRepo contract on the in-memory fake.
import { describePushSubscriptionsRepoContract } from './pushSubscriptionsRepo.contract.ts';
import { InMemoryPushSubscriptionsRepo } from './inMemoryPushSubscriptionsRepo.ts';

describePushSubscriptionsRepoContract(
  'InMemoryPushSubscriptionsRepo',
  () => new InMemoryPushSubscriptionsRepo(),
);
