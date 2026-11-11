// A real MongoDB for the opt-in contract runs (`*.contract.test.ts` next to each Mongo repo).
// Test-only, like testRequest.ts. Every route test runs on the in-memory fakes; the contract suites
// (`*.contract.ts`) prove each fake behaves like its Mongo implementation, but only when they also
// run against a real server. That run needs a database, so it is opt-in and outside green: without
// MONGODB_TEST_URI the suites are skipped and nothing connects (tests never touch the network).
//
// To run them, point MONGODB_TEST_URI at a throwaway database (MongoDB 6.0 or later: the orders
// index uses `$in` in a partial filter), e.g. a local `mongod`, or a `bottlerun_test` database on
// the Atlas cluster:
//
//   MONGODB_TEST_URI='mongodb://localhost:27017/bottlerun_test' bash .claude/checks.sh test \
//     apps/api/src/orders/mongoOrdersRepo.contract.test.ts \
//     apps/api/src/rounds/mongoRoundsRepo.contract.test.ts \
//     apps/api/src/attempts/mongoAttemptStore.contract.test.ts \
//     apps/api/src/push/mongoPushSubscriptionsRepo.contract.test.ts
//
// Safety: each suite empties its collection before every test and drops it afterwards. The name
// of the database must contain "test" (testDatabaseName), checked before any client exists, so a
// production URI pasted in by mistake fails instead of wiping the orders. Each suite touches only
// its own collection and never drops the database: Vitest runs the files in parallel on one database.
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MONGO_CLIENT_OPTIONS } from './mongoClient.ts';
import { databaseNameFromUri } from './mongoDeps.ts';

/** What the name of a test database must contain, in any case: `bottlerun_test`, `BottleRun_Test`. */
const TEST_DATABASE_MARK = /test/iu;

/**
 * MONGODB_TEST_URI from `env`, or undefined when it is unset or empty (`MONGODB_TEST_URI=` in a
 * shell means "no database", not a connection string the driver would reject).
 */
export function mongoTestUriFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const uri = env.MONGODB_TEST_URI;
  return uri === '' ? undefined : uri;
}

/**
 * The connection string of the throwaway database for the contract runs; undefined means "skip
 * them". Wrap each suite in `describe.runIf(MONGODB_TEST_URI !== undefined)`. It holds the
 * password: never log it.
 */
export const MONGODB_TEST_URI: string | undefined = mongoTestUriFromEnv(process.env);

/**
 * The database named in `uri`, once it is known to be a throwaway one: its name contains `test`
 * in any case (`bottlerun_test`). The contract suites empty and drop their collections, so run on
 * the production database (`bottlerun`) they would delete the orders.
 *
 * Pure: it only reads the string, so it runs before any client exists.
 *
 * @param uri MONGODB_TEST_URI. It holds the password, so no error message repeats it.
 * @throws Error when the URI names no database (the driver would silently use one called `test`,
 *   and an explicit name is the only thing the check can trust) or one whose name lacks `test`.
 */
export function testDatabaseName(uri: string): string {
  const name = databaseNameFromUri(uri);
  if (name === undefined) {
    throw new Error(
      'MONGODB_TEST_URI must name a throwaway database whose name contains "test", e.g. ' +
        'mongodb://localhost:27017/bottlerun_test: the Mongo contract suites empty and drop ' +
        'their collections.',
    );
  }
  if (!TEST_DATABASE_MARK.test(name)) {
    throw new Error(
      `Refusing to run the Mongo contract suites on the database ${JSON.stringify(name)}: its name ` +
        'does not contain "test". The suites empty and drop their collections, so a real ' +
        'database would lose its data. Use a throwaway one, e.g. bottlerun_test.',
    );
  }
  return name;
}

/**
 * Connects the enclosing `describe` block to the MONGODB_TEST_URI database and keeps one of its
 * collections empty for every test. It only registers hooks, so call it inside a
 * `describe.runIf(MONGODB_TEST_URI !== undefined)` block: a skipped block runs none of them and
 * opens no client.
 *
 * - beforeAll: checks the name ({@link testDatabaseName}) before creating the client, connects,
 *   and drops `collectionName`, so documents or outdated indexes left by an interrupted run do
 *   not leak in.
 * - beforeEach: empties `collectionName`. `deleteMany` keeps the indexes, so a repo's one-time
 *   index creation is a quick no-op after the first test. Vitest runs outer beforeEach hooks
 *   first, so this runs before the contract's own `makeRepo`, which then gets the empty
 *   collection the contracts require.
 * - afterAll: drops `collectionName` and closes the client.
 *
 * The client uses the api's {@link MONGO_CLIENT_OPTIONS} (above all `ignoreUndefined`, which the
 * repos' behaviour depends on), named apart in the server's logs, and its own instance: not the
 * process-wide one of getMongoClient, which would outlive the block.
 *
 * @param collectionName The one collection the code under test uses (`orders`, `rounds`, …). Each
 *   file has its own, so the files Vitest runs in parallel never touch each other's data.
 * @returns The connected database, for the contract's `makeRepo`; it throws if called before the
 *   beforeAll hook has connected.
 */
export function useTestMongoDb(collectionName: string): () => Db {
  let client: MongoClient | undefined;
  // Set only once connected, so afterAll knows whether there is a collection to drop.
  let db: Db | undefined;

  function connectedDb(): Db {
    if (db === undefined) {
      throw new Error('The test database is not connected: use it inside a test or a hook.');
    }
    return db;
  }

  beforeAll(async () => {
    if (MONGODB_TEST_URI === undefined) {
      throw new Error(
        'MONGODB_TEST_URI is not set: wrap the suite in describe.runIf(MONGODB_TEST_URI !== undefined).',
      );
    }
    const name = testDatabaseName(MONGODB_TEST_URI);
    client = new MongoClient(MONGODB_TEST_URI, {
      ...MONGO_CLIENT_OPTIONS,
      appName: 'bottlerun-contract-tests',
    });
    await client.connect();
    // By the name just checked, not the driver's own reading of the URI: the database the suites
    // empty is exactly the one the guard accepted.
    db = client.db(name);
    // The driver answers false, not an error, when the collection does not exist yet.
    await db.collection(collectionName).drop();
  });

  beforeEach(async () => {
    await connectedDb().collection(collectionName).deleteMany({});
  });

  afterAll(async () => {
    try {
      await db?.collection(collectionName).drop();
    } finally {
      await client?.close();
    }
  });

  return connectedDb;
}
