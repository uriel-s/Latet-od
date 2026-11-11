// The OrdersRepo contract on a real MongoDB: proves MongoOrdersRepo behaves like the in-memory fake
// every route test relies on. Opt-in and outside green: skipped unless MONGODB_TEST_URI is set
// (db/testMongo.ts explains it and runs all four Mongo contract files). This one alone:
//   MONGODB_TEST_URI='mongodb://localhost:27017/bottlerun_test' bash .claude/checks.sh test apps/api/src/orders/mongoOrdersRepo.contract.test.ts
import { describe } from 'vitest';
import { MONGODB_TEST_URI, useTestMongoDb } from '../db/testMongo.ts';
import { MongoOrdersRepo } from './mongoOrdersRepo.ts';
import { describeOrdersRepoContract } from './ordersRepo.contract.ts';

describe.runIf(MONGODB_TEST_URI !== undefined)('MongoOrdersRepo on a real MongoDB', () => {
  // Connects for this block and empties `orders` before every test, as the contract requires.
  const testDb = useTestMongoDb('orders');

  describeOrdersRepoContract('MongoOrdersRepo', () => new MongoOrdersRepo(testDb()));
});
