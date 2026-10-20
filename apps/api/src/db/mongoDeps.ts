// The production AppDeps that live in the database: the Mongo repos on the database named in
// MONGODB_URI (ADR-0001); the login's and the WhatsApp messages' settings come from env instead
// (auth/authConfig.ts, messages/messagingConfig.ts). The entry points call createMongoDeps once
// per process: server.ts now, the Vercel function entry in section 10. Nothing here touches the
// network; the driver connects on the first operation.
import type { AppDeps } from '../deps.ts';
import { MongoAttemptStore } from '../attempts/mongoAttemptStore.ts';
import { MongoOrdersRepo } from '../orders/mongoOrdersRepo.ts';
import { getMongoDb, pingMongo } from './mongoClient.ts';

/**
 * The parts of a MongoDB connection string, as the driver splits them (the HOSTS_REGEX of
 * `mongodb-connection-string-url`, which the driver uses): scheme, optional `user:password@`, the
 * host list (`h1:27017,h2:27017` or one SRV name), then `rest`, which holds `/<database>` and the
 * `?options`. A password may not contain an unescaped `/`, `?` or `@` (the driver refuses one), so
 * the first `/` after the host list starts the path.
 */
const CONNECTION_STRING_PARTS = /^[^/]+:\/\/(?:[^:@]*(?::[^@]*)?@)?[^/?@]*(?<rest>.*)$/su;

/**
 * The database named in the path of a MongoDB connection string, decoded the way the driver
 * decodes it: `bottlerun` in `mongodb+srv://u:p@c.example.mongodb.net/bottlerun?retryWrites=true`.
 * Undefined when the string has no path or an empty one (`…mongodb.net`, `…mongodb.net/`,
 * `…mongodb.net/?retryWrites=true`); with such a string the driver silently uses `test`.
 *
 * Pure: it only reads the string, so it can be checked before any client exists.
 */
export function databaseNameFromUri(uri: string): string | undefined {
  const rest = CONNECTION_STRING_PARTS.exec(uri)?.groups?.rest ?? '';
  if (!rest.startsWith('/')) return undefined;
  // The path ends where the options (or a fragment) begin.
  const encodedName = rest.slice(1).split(/[?#]/u, 1)[0];
  if (!encodedName) return undefined;
  try {
    return decodeURIComponent(encodedName);
  } catch {
    // Malformed percent-encoding: the driver refuses the string too.
    return undefined;
  }
}

/**
 * The api's real dependencies on the database named in `uri`: every AppDeps piece but `auth` and
 * `messaging`, which come from env, not from the database (authDepsFromEnv, auth/authConfig.ts;
 * messagingDepsFromEnv, messages/messagingConfig.ts); the entry point joins the three. Call it
 * once per process, next to the client (the repos create their indexes once per instance):
 * server.ts does now, and so will the Vercel function entry (section 10).
 *
 * Creates the repos without connecting; `db.ping()` (GET /api/health) opens the connection early.
 *
 * @param uri `MONGODB_URI`. It holds the password: never log it or put it in an error message.
 * @throws Error when the URI names no database, before any client is created: without one the
 *   driver would silently store the orders in a database called `test`.
 */
export function createMongoDeps(uri: string): Omit<AppDeps, 'auth' | 'messaging'> {
  if (databaseNameFromUri(uri) === undefined) {
    throw new Error(
      'MONGODB_URI must name the database, e.g. mongodb+srv://<user>:<password>@<cluster>.mongodb.net/bottlerun',
    );
  }
  const db = getMongoDb(uri);
  return {
    orders: new MongoOrdersRepo(db),
    attempts: new MongoAttemptStore(db),
    db: { ping: () => pingMongo(db) },
  };
}
