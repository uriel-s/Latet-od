// Web Push (VAPID) settings from env (ADR-0013): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and
// VAPID_SUBJECT are optional as a group — when all three are unset or empty, Web Push is disabled
// and the api runs normally. When any one is set, all three must be present and valid, or startup
// fails immediately without repeating secret values.
import type { PushDeps } from '../deps.ts';
import { WebPushSender } from './webPushSender.ts';

const ENV_HINT = 'Set them in apps/api/.env (see .env.example) or in the hosting env.';

const VAPID_KEY_RECIPE =
  `node -e "const c=require('node:crypto').createECDH('prime256v1');c.generateKeys();` +
  `console.log('VAPID_PUBLIC_KEY='+c.getPublicKey('base64url'));` +
  `console.log('VAPID_PRIVATE_KEY='+c.getPrivateKey('base64url'))"`;

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Validates `VAPID_SUBJECT` (RFC 8292 §2.1): must be a `mailto:<email>` or `https://<host>` URL
 * with no embedded credentials (`user:password@`).
 *
 * @throws Error naming `VAPID_SUBJECT` without repeating its value.
 */
export function parseVapidSubject(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `VAPID_SUBJECT is not a valid URI: use "mailto:<email>" or "https://<your-domain>". ${ENV_HINT}`,
    );
  }

  if (url.protocol === 'mailto:') {
    if (!url.pathname || !SIMPLE_EMAIL.test(url.pathname) || url.search !== '' || url.hash !== '') {
      throw new Error(
        `VAPID_SUBJECT mailto URI must be a plain email address, e.g. "mailto:example@gmail.com". ${ENV_HINT}`,
      );
    }
    return value;
  }

  if (url.protocol === 'https:') {
    if (url.username !== '' || url.password !== '') {
      throw new Error(
        `VAPID_SUBJECT must not contain a username or password: use "https://<your-domain>". ${ENV_HINT}`,
      );
    }
    return value;
  }

  throw new Error(
    `VAPID_SUBJECT must start with "mailto:" or "https://", e.g. "mailto:example@gmail.com". ${ENV_HINT}`,
  );
}

/**
 * Builds {@link PushDeps} from `env` (normally `process.env`, ADR-0013):
 *
 * - All three `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` unset or empty: returns
 *   `null`, Web Push disabled (`AppDeps.push` is null; the api runs normally without it).
 * - Partially set: throws naming the missing variable(s).
 * - All three set: validates `VAPID_SUBJECT` and the P-256 key pair, and returns a
 *   {@link WebPushSender} with the public key.
 *
 * @throws Error naming the offending `VAPID_*` variable(s), never repeating any env value.
 */
export function pushDepsFromEnv(env: NodeJS.ProcessEnv): PushDeps | null {
  const publicKey = env.VAPID_PUBLIC_KEY ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY ?? '';
  const subject = env.VAPID_SUBJECT ?? '';

  if (publicKey === '' && privateKey === '' && subject === '') {
    return null;
  }

  const missing: string[] = [];
  if (publicKey === '') missing.push('VAPID_PUBLIC_KEY');
  if (privateKey === '') missing.push('VAPID_PRIVATE_KEY');
  if (subject === '') missing.push('VAPID_SUBJECT');

  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} not set: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must ` +
        `all be set together to enable Web Push (or all left unset to disable it). Generate keys with ${VAPID_KEY_RECIPE}. ${ENV_HINT}`,
    );
  }

  const validSubject = parseVapidSubject(subject);
  const sender = new WebPushSender({
    publicKey,
    privateKey,
    subject: validSubject,
  });

  return {
    publicKey,
    sender,
  };
}
