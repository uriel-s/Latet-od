// Unit tests of the module-level client. Creating a MongoClient does not connect, and these tests
// never run an operation, so nothing here touches the network.
import { describe, expect, it, vi } from 'vitest';

// Placeholder addresses: nothing listens there, and nothing tries to.
const URI = 'mongodb://127.0.0.1:9/bottlerun_test';
const OTHER_URI = 'mongodb://127.0.0.1:9/other_db';

/** A fresh copy of the module, so each test starts with no client yet. */
async function freshModule(): Promise<typeof import('./mongoClient.ts')> {
  vi.resetModules();
  return import('./mongoClient.ts');
}

describe('getMongoClient', () => {
  it('returns the same client on every call, even for another uri', async () => {
    const { getMongoClient } = await freshModule();

    const first = getMongoClient(URI);

    expect(getMongoClient(URI)).toBe(first);
    expect(getMongoClient(OTHER_URI)).toBe(first);
  });

  it('creates the client with the api options', async () => {
    const { getMongoClient } = await freshModule();

    const client = getMongoClient(URI);

    expect(client.bsonOptions.ignoreUndefined).toBe(true);
    expect(client.options.serverSelectionTimeoutMS).toBe(5000);
    expect(client.options.appName).toBe('bottlerun-api');
    expect(client.options.maxPoolSize).toBe(5);
  });
});

describe('getMongoDb', () => {
  it('is the database named in the uri path', async () => {
    const { getMongoDb } = await freshModule();

    expect(getMongoDb(URI).databaseName).toBe('bottlerun_test');
  });
});
