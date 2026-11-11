// The RoundsRepo contract on a real MongoDB: proves MongoRoundsRepo behaves like the in-memory fake
// every route test relies on. Opt-in and outside green: skipped unless MONGODB_TEST_URI is set
// (db/testMongo.ts explains it and runs all four Mongo contract files). This one alone:
//   MONGODB_TEST_URI='mongodb://localhost:27017/bottlerun_test' bash .claude/checks.sh test apps/api/src/rounds/mongoRoundsRepo.contract.test.ts
import { describe } from 'vitest';
import { MONGODB_TEST_URI, useTestMongoDb } from '../db/testMongo.ts';
import { MongoRoundsRepo } from './mongoRoundsRepo.ts';
import { describeRoundsRepoContract } from './roundsRepo.contract.ts';

describe.runIf(MONGODB_TEST_URI !== undefined)('MongoRoundsRepo on a real MongoDB', () => {
  // Connects for this block and empties `rounds` before every test, as the contract requires.
  const testDb = useTestMongoDb('rounds');

  describeRoundsRepoContract('MongoRoundsRepo', () => new MongoRoundsRepo(testDb()));
});
