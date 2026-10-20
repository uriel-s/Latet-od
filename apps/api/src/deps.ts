// What the api needs from the world outside its own code, passed to createApp(deps). Production
// builds the Mongo implementations once per process (db/mongoDeps.ts), and the login's, the
// WhatsApp messages' and the route's settings from env (auth/authConfig.ts,
// messages/messagingConfig.ts, route/routeConfig.ts); envDeps.ts joins them for both entry points.
// Tests pass in-memory fakes (fakeDeps.ts), so no test touches the network or Atlas.
import type { DistanceMatrix, GeoPoint } from '@bottlerun/shared';
import type { AttemptStore } from './attempts/attemptStore.ts';
import type { VerifyCredentials } from './auth/credentials.ts';
import type { MessageSender } from './messages/messageSender.ts';
import type { OrdersRepo } from './orders/ordersRepo.ts';
import type { RoundsRepo } from './rounds/roundsRepo.ts';

/** Everything the app talks to outside itself; tests pass fakes (CLAUDE.md: every external call behind an interface). */
export interface AppDeps {
  /** Stored orders (collection `orders`). */
  orders: OrdersRepo;
  /** Stored rounds (collection `rounds`). */
  rounds: RoundsRepo;
  /** Attempt counts for login limits and the form's rate limit (ADR-0004). */
  attempts: AttemptStore;
  /** Whether the database answers, for /api/health. */
  db: DbHealth;
  /** The collector's login and session cookie (ADR-0004). */
  auth: AuthDeps;
  /** The WhatsApp messages: who sends them, and the origin of the links inside (ADR-0003). */
  messaging: MessagingDeps;
  /** Where routes start and how far apart two points are, for planning a round (ADR-0005). */
  route: RouteDeps;
}

/**
 * The {@link AppDeps} pieces that live in the database: everything but `auth`, `messaging` and
 * `route`, which come from env. Production builds them with createMongoDeps (db/mongoDeps.ts),
 * and depsFromEnv (envDeps.ts) joins them with the other three.
 */
export type DbDeps = Omit<AppDeps, 'auth' | 'messaging' | 'route'>;

/** Whether the database answers. /api/health uses it, which also opens the connection early (warm-up, ADR-0002). */
export interface DbHealth {
  /** Resolves when the database answers; rejects when it cannot be reached. */
  ping(): Promise<void>;
}

/**
 * What the login routes and the collector guard need (ADR-0004). Production builds it from env
 * (authDepsFromEnv, auth/authConfig.ts); tests use createFakeAuth (fakeDeps.ts).
 */
export interface AuthDeps {
  /** ADR-0004: checks the collector's password. */
  verifyCredentials: VerifyCredentials;
  /** HMAC key of the session cookie (SESSION_SECRET). Replacing it logs out every device. */
  sessionSecret: string;
  /** The cookie's Secure attribute: true everywhere except local development. */
  secureCookie: boolean;
  /** Clock for issuing, expiring and renewing sessions; defaults to the real clock. Tests pass a fake. */
  now?: () => Date;
}

/**
 * What sending a WhatsApp message needs (ADR-0003). Production builds it from env
 * (messagingDepsFromEnv, messages/messagingConfig.ts); tests use createFakeMessaging (fakeDeps.ts).
 */
export interface MessagingDeps {
  /** Sends or prepares the message: a wa.me link today (MESSAGE_SENDER, default `wame`). */
  sender: MessageSender;
  /**
   * The site's public origin (PUBLIC_BASE_URL), without a trailing slash, e.g.
   * `https://latet-od.example`. The links in messages are `${publicBaseUrl}/o/<token>`.
   */
  publicBaseUrl: string;
}

/**
 * What planning a round's route needs (ADR-0005). Production builds it from env
 * (routeDepsFromEnv, route/routeConfig.ts); tests use createFakeRoute (fakeDeps.ts). The route's
 * end, the drop-off point, is not here: it is the fixed DROP_OFF in config.ts.
 */
export interface RouteDeps {
  /**
   * Where every route starts: ROUTE_START, Yoel's home. Private: it comes from env only, and is
   * never logged, sent to the browser or written into code or docs.
   */
  start: GeoPoint;
  /** How far apart two points are: straight-line distance today (ADR-0005). */
  distance: DistanceMatrix;
}
