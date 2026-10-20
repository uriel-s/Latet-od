// In-memory dependencies for api tests: route tests build their app with
// `createApp(createFakeDeps())`, and override one piece when they need to see or steer it.
import { randomBytes } from 'node:crypto';
import { straightLineDistance, type GeoPoint } from '@bottlerun/shared';
import { InMemoryAttemptStore } from './attempts/inMemoryAttemptStore.ts';
import type { AppDeps, AuthDeps, MessagingDeps, RouteDeps } from './deps.ts';
import { FakeSender } from './messages/fakeSender.ts';
import { InMemoryOrdersRepo } from './orders/inMemoryOrdersRepo.ts';
import { InMemoryRoundsRepo } from './rounds/inMemoryRoundsRepo.ts';

/**
 * The password {@link createFakeAuth}'s verifier accepts. Test-only, like this whole module: the
 * real password exists only as its hash, in COLLECTOR_PASSWORD_HASH.
 */
export const FAKE_COLLECTOR_PASSWORD = 'fake collector password for tests';

/**
 * Login settings for tests: a verifier that accepts exactly {@link FAKE_COLLECTOR_PASSWORD} (a
 * plain comparison, no scrypt, so tests stay fast), a fresh random session secret on each call,
 * the Secure cookie as in production, and the real clock.
 *
 * @param overrides E.g. `{ now: () => clock }` to drive issuing and renewal, or the real
 *   `createVerifyCredentials(hash)` to run the whole scrypt path. A test that signs its own
 *   cookies keeps the returned object and signs with its `sessionSecret`.
 */
export function createFakeAuth(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    verifyCredentials: (password) =>
      Promise.resolve(password === FAKE_COLLECTOR_PASSWORD ? { sub: 'collector' } : null),
    sessionSecret: randomBytes(32).toString('base64url'),
    secureCookie: true,
    ...overrides,
  };
}

/**
 * The origin {@link createFakeMessaging} puts in front of every link: a reserved `.test` domain,
 * so a link in a test can never reach a real site.
 */
export const FAKE_PUBLIC_BASE_URL = 'https://latet-od.test';

/**
 * WhatsApp settings for tests: a fresh {@link FakeSender} (records every message, answers with a
 * `manual` https url) and {@link FAKE_PUBLIC_BASE_URL}.
 *
 * @param overrides E.g. `{ sender: new FakeSender(() => ({ mode: 'failed', reason: 'x' })) }` for
 *   a sender that fails. A test that inspects what was sent keeps its own FakeSender and passes it.
 */
export function createFakeMessaging(overrides: Partial<MessagingDeps> = {}): MessagingDeps {
  return { sender: new FakeSender(), publicBaseUrl: FAKE_PUBLIC_BASE_URL, ...overrides };
}

/**
 * The route's start point in tests: a made-up round-number point a few kilometres from the
 * drop-off, inside ROUTE_START's limit. It is nobody's home: the real one exists only in env.
 */
export const FAKE_ROUTE_START: GeoPoint = { lat: 31.7, lng: 35.0 };

/**
 * Route settings for tests: {@link FAKE_ROUTE_START} and the real straight-line distances.
 *
 * @param overrides E.g. `{ distance: { distance: (from, to) => … } }` for a distance table the
 *   test controls, so the expected stop order does not depend on real geography.
 */
export function createFakeRoute(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return { start: FAKE_ROUTE_START, distance: straightLineDistance, ...overrides };
}

/**
 * Fresh, empty fakes for every dependency: an {@link InMemoryOrdersRepo}, an
 * {@link InMemoryRoundsRepo}, an {@link InMemoryAttemptStore} on the real clock, a database whose
 * ping always answers, {@link createFakeAuth}'s login, {@link createFakeMessaging}'s WhatsApp
 * sender and {@link createFakeRoute}'s route settings. Each call makes new instances, so tests
 * never share state.
 *
 * @param overrides Pieces to use instead, e.g. `{ db: { ping: () => Promise.reject(...) } }` for a
 *   database that is down, or a repo the test keeps a reference to and inspects.
 */
export function createFakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    orders: new InMemoryOrdersRepo(),
    rounds: new InMemoryRoundsRepo(),
    attempts: new InMemoryAttemptStore(),
    db: { ping: () => Promise.resolve() },
    auth: createFakeAuth(),
    messaging: createFakeMessaging(),
    route: createFakeRoute(),
    ...overrides,
  };
}
