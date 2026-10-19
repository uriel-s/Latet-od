// The api's one connection to MongoDB Atlas (ADR-0001, ADR-0002 "חיבור ל-Mongo"). The api runs as
// a Vercel function: the platform keeps the module loaded between invocations of a warm instance,
// so a client kept at module level is reused instead of opening a new connection per request.
// Nothing here talks to the server until the first operation; tests never call these functions
// against a real database (they use the in-memory repos).
import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

/**
 * Options of the process's client. Exported so a test can check them without connecting.
 *
 * - `ignoreUndefined`: a field set to `undefined` is left out instead of stored as `null`, which
 *   `orderSchema` rejects (optional fields are absent, never null). The repos also strip
 *   `undefined` themselves; this covers any write that does not go through them.
 * - `serverSelectionTimeoutMS`: when Atlas is unreachable, /api/health and requests fail in about
 *   5 seconds instead of the driver's default 30, so the form can show its error and retry.
 * - `appName`: names our connections in the Atlas UI and logs.
 * - `maxPoolSize`: one function instance handles a request or a few at a time and needs few
 *   connections; a small pool keeps many warm instances far from Atlas Free's 500-connection cap.
 */
export const MONGO_CLIENT_OPTIONS: Readonly<MongoClientOptions> = {
  ignoreUndefined: true,
  serverSelectionTimeoutMS: 5000,
  appName: 'bottlerun-api',
  maxPoolSize: 5,
};

// The process's client, created by the first getMongoClient() call. Module state on purpose: it
// is what survives between invocations of a warm serverless instance (ADR-0002).
let client: MongoClient | undefined;

/**
 * The process's one MongoClient: created on the first call, the same instance on every later call.
 *
 * It does not call `connect()`: the driver connects on the first operation (and reconnects after a
 * failure on its own), so creating it is free and a cold start pays for the connection only when
 * a request needs the database. Use {@link pingMongo} to open it early (warm-up).
 *
 * One database per process: a later call with a different `uri` still returns the first client.
 *
 * @param uri The connection string (`MONGODB_URI`). It holds the password: never log it.
 */
export function getMongoClient(uri: string): MongoClient {
  client ??= new MongoClient(uri, MONGO_CLIENT_OPTIONS);
  return client;
}

/**
 * The api's database: the one named in the path of the connection string, e.g. `bottlerun` in
 * `mongodb+srv://user:pass@cluster0.example.mongodb.net/bottlerun?retryWrites=true&w=majority`.
 *
 * Put the name in the URI: without a path the driver silently falls back to a database called
 * `test`, and the orders would be stored there.
 *
 * @param uri The connection string (`MONGODB_URI`); see {@link getMongoClient}.
 */
export function getMongoDb(uri: string): Db {
  return getMongoClient(uri).db();
}

/**
 * Asks the server to answer a `ping`; rejects when it cannot be reached within the client's
 * server-selection timeout. For /api/health, which the form calls when it loads: the ping also
 * opens the connection, so it is warm by the time the customer submits (ADR-0002, warm-up).
 */
export async function pingMongo(db: Db): Promise<void> {
  await db.command({ ping: 1 });
}
