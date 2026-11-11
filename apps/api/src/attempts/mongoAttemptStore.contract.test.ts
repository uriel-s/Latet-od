// The AttemptStore contract on a real MongoDB: proves MongoAttemptStore behaves like the in-memory
// fake the login and rate-limit tests rely on. Opt-in and outside green: skipped unless
// MONGODB_TEST_URI is set (db/testMongo.ts explains it and runs all four Mongo contract files).
// This one alone:
//   MONGODB_TEST_URI='mongodb://localhost:27017/bottlerun_test' bash .claude/checks.sh test apps/api/src/attempts/mongoAttemptStore.contract.test.ts
import { describe } from 'vitest';
import { MONGODB_TEST_URI, useTestMongoDb } from '../db/testMongo.ts';
import { describeAttemptStoreContract } from './attemptStore.contract.ts';
import { MongoAttemptStore } from './mongoAttemptStore.ts';

describe.runIf(MONGODB_TEST_URI !== undefined)('MongoAttemptStore on a real MongoDB', () => {
  // Connects for this block and empties `loginAttempts` before every test, as the contract
  // requires. The contract's clock starts in 2100, so the TTL index deletes nothing mid-test.
  const testDb = useTestMongoDb('loginAttempts');

  describeAttemptStoreContract(
    'MongoAttemptStore',
    (now) => new MongoAttemptStore(testDb(), { now }),
  );
});
