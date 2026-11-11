// The PushSubscriptionsRepo contract on a real MongoDB: proves MongoPushSubscriptionsRepo behaves
// like the in-memory fake the push tests rely on. Opt-in and outside green: skipped unless
// MONGODB_TEST_URI is set (db/testMongo.ts explains it and runs all four Mongo contract files).
// This one alone:
//   MONGODB_TEST_URI='mongodb://localhost:27017/bottlerun_test' bash .claude/checks.sh test apps/api/src/push/mongoPushSubscriptionsRepo.contract.test.ts
import { describe } from 'vitest';
import { MONGODB_TEST_URI, useTestMongoDb } from '../db/testMongo.ts';
import { MongoPushSubscriptionsRepo } from './mongoPushSubscriptionsRepo.ts';
import { describePushSubscriptionsRepoContract } from './pushSubscriptionsRepo.contract.ts';

describe.runIf(MONGODB_TEST_URI !== undefined)(
  'MongoPushSubscriptionsRepo on a real MongoDB',
  () => {
    // Connects for this block and empties `pushSubscriptions` before every test, as the contract
    // requires.
    const testDb = useTestMongoDb('pushSubscriptions');

    describePushSubscriptionsRepoContract(
      'MongoPushSubscriptionsRepo',
      () => new MongoPushSubscriptionsRepo(testDb()),
    );
  },
);
