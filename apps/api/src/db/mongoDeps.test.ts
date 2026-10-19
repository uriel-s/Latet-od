// Unit tests of the production deps factory. Creating a MongoClient does not connect, and no test
// here runs an operation or a ping, so nothing touches the network.
import { describe, expect, it, vi } from 'vitest';
import { databaseNameFromUri } from './mongoDeps.ts';

// Placeholder addresses: nothing listens there, and nothing tries to.
const URI = 'mongodb://127.0.0.1:9/bottlerun_test';

/**
 * Fresh copies of the factory and of the client module it uses (one module registry), so each
 * test starts with no client yet and can see whether one was created.
 */
async function freshModules(): Promise<{
  deps: typeof import('./mongoDeps.ts');
  client: typeof import('./mongoClient.ts');
  orders: typeof import('../orders/mongoOrdersRepo.ts');
  attempts: typeof import('../attempts/mongoAttemptStore.ts');
}> {
  vi.resetModules();
  return {
    deps: await import('./mongoDeps.ts'),
    client: await import('./mongoClient.ts'),
    orders: await import('../orders/mongoOrdersRepo.ts'),
    attempts: await import('../attempts/mongoAttemptStore.ts'),
  };
}

describe('databaseNameFromUri', () => {
  it('reads the database of an Atlas SRV string with options', () => {
    expect(
      databaseNameFromUri(
        'mongodb+srv://user:pass@cluster0.example.mongodb.net/bottlerun?retryWrites=true&w=majority',
      ),
    ).toBe('bottlerun');
  });

  it('reads the database of a plain string without options', () => {
    expect(databaseNameFromUri('mongodb://localhost:27017/bottlerun')).toBe('bottlerun');
  });

  it('reads the database after several hosts', () => {
    expect(
      databaseNameFromUri(
        'mongodb://u:p@h1.example.com:27017,h2.example.com:27017/orders_db?replicaSet=rs0',
      ),
    ).toBe('orders_db');
  });

  it('reads the database when the string has no credentials', () => {
    expect(databaseNameFromUri('mongodb://h1:27017,h2:27017/bottlerun')).toBe('bottlerun');
  });

  it('is not fooled by a percent-encoded password', () => {
    // `p/ss?w@rd` encoded: none of its characters may end the credentials or start the path.
    expect(
      databaseNameFromUri('mongodb+srv://user:p%2Fss%3Fw%40rd@c.example.mongodb.net/bottlerun'),
    ).toBe('bottlerun');
  });

  it('decodes a percent-encoded database name like the driver', () => {
    expect(databaseNameFromUri('mongodb://localhost/my%2Ddb')).toBe('my-db');
  });

  it('is undefined without a path', () => {
    expect(databaseNameFromUri('mongodb+srv://user:pass@c.example.mongodb.net')).toBeUndefined();
    expect(databaseNameFromUri('mongodb://h1:27017,h2:27017')).toBeUndefined();
  });

  it('is undefined for an empty path', () => {
    expect(databaseNameFromUri('mongodb+srv://user:pass@c.example.mongodb.net/')).toBeUndefined();
    expect(
      databaseNameFromUri('mongodb+srv://user:pass@c.example.mongodb.net/?retryWrites=true'),
    ).toBeUndefined();
  });

  it('is undefined for options with no path', () => {
    expect(databaseNameFromUri('mongodb://localhost:27017?retryWrites=true')).toBeUndefined();
  });

  it('is undefined for a string that is not a connection string', () => {
    expect(databaseNameFromUri('')).toBeUndefined();
    expect(databaseNameFromUri('bottlerun')).toBeUndefined();
  });
});

describe('createMongoDeps', () => {
  it('builds the Mongo repos without connecting', async () => {
    const { deps, orders, attempts } = await freshModules();

    const appDeps = deps.createMongoDeps(URI);

    expect(appDeps.orders).toBeInstanceOf(orders.MongoOrdersRepo);
    expect(appDeps.attempts).toBeInstanceOf(attempts.MongoAttemptStore);
    // Not called: a ping would try to reach the placeholder address.
    expect(appDeps.db).toEqual({ ping: expect.any(Function) as unknown });
  });

  it('uses the process client, on the database named in the uri', async () => {
    const { deps, client } = await freshModules();

    deps.createMongoDeps(URI);

    // The factory created the module-level client: a later call returns it, uri ignored.
    expect(client.getMongoDb('mongodb://127.0.0.1:9/other').databaseName).toBe('bottlerun_test');
  });

  it('refuses a uri without a database, before creating any client', async () => {
    const { deps, client } = await freshModules();
    const uriWithSecret = 'mongodb+srv://user:s3cret-pass@c.example.mongodb.net/?retryWrites=true';

    let thrown: unknown;
    try {
      deps.createMongoDeps(uriWithSecret);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const { message } = thrown as Error;
    expect(message).toMatch(/MONGODB_URI must name the database/u);
    // The uri holds the password: the message must not repeat it.
    expect(message).not.toContain('s3cret-pass');
    expect(message).not.toContain('c.example.mongodb.net');
    // No client was created: the first one is made now, from this uri, with its database.
    expect(client.getMongoDb('mongodb://127.0.0.1:9/probe').databaseName).toBe('probe');
  });
});
