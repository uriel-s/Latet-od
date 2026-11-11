// Unit tests of the guard and the env reading of the opt-in Mongo contract runs. Only pure
// functions are called: no client is created and nothing touches the network.
import { describe, expect, it } from 'vitest';
import { mongoTestUriFromEnv, testDatabaseName } from './testMongo.ts';

/** A made-up password, to check that no error message repeats it. */
const PASSWORD = 'S3cretPassw0rd';

/** The error `testDatabaseName(uri)` throws; fails the test if it returns. */
function guardErrorOf(uri: string): Error {
  try {
    testDatabaseName(uri);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  return expect.fail(`expected ${uri} to be refused`);
}

describe('testDatabaseName', () => {
  it('accepts a local database whose name contains test', () => {
    expect(testDatabaseName('mongodb://localhost:27017/bottlerun_test')).toBe('bottlerun_test');
  });

  it('accepts test in any case, on an Atlas string with options', () => {
    expect(
      testDatabaseName('mongodb+srv://u:p@c.example.mongodb.net/BottleRun_Test?retryWrites=true'),
    ).toBe('BottleRun_Test');
  });

  it.each([
    'mongodb://localhost:27017',
    'mongodb://localhost:27017/',
    'mongodb+srv://u:p@c.example.mongodb.net/?retryWrites=true',
  ])('rejects %s, which names no database', (uri) => {
    expect(guardErrorOf(uri).message).toContain('must name a throwaway database');
  });

  it('rejects a database whose name does not contain test, saying why', () => {
    const { message } = guardErrorOf('mongodb://localhost:27017/bottlerun');

    expect(message).toContain('"bottlerun"');
    expect(message).toContain('does not contain "test"');
    expect(message).toContain('would lose its data');
  });

  it.each([
    `mongodb+srv://bottlerun:${PASSWORD}@cluster0.example.mongodb.net/bottlerun?retryWrites=true`,
    `mongodb+srv://bottlerun:${PASSWORD}@cluster0.example.mongodb.net/?retryWrites=true`,
  ])('never puts the uri or its password in the error (%#)', (uri) => {
    const { message } = guardErrorOf(uri);

    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('cluster0.example.mongodb.net');
  });
});

describe('mongoTestUriFromEnv', () => {
  it('reads MONGODB_TEST_URI', () => {
    const uri = 'mongodb://localhost:27017/bottlerun_test';

    expect(mongoTestUriFromEnv({ MONGODB_TEST_URI: uri })).toBe(uri);
  });

  it('treats an unset or empty variable as no database', () => {
    expect(mongoTestUriFromEnv({})).toBeUndefined();
    expect(mongoTestUriFromEnv({ MONGODB_TEST_URI: '' })).toBeUndefined();
  });

  it('does not read MONGODB_URI, so the production database is never picked up', () => {
    expect(
      mongoTestUriFromEnv({ MONGODB_URI: 'mongodb://localhost:27017/bottlerun' }),
    ).toBeUndefined();
  });
});
