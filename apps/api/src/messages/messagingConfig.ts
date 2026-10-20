// The WhatsApp messages' settings from env (ADR-0003): MESSAGE_SENDER picks the MessageSender and
// PUBLIC_BASE_URL is the site's origin, which every link inside a message starts with. The entry
// points call messagingDepsFromEnv once at startup (server.ts now, the Vercel function entry in
// section 10), so a bad value stops the startup instead of sending customers broken links.
import type { MessagingDeps } from '../deps.ts';
import type { MessageSender } from './messageSender.ts';
import { WaMeLinkSender } from './waMeLinkSender.ts';

/** Where the error messages point for the full list of variables. */
const ENV_HINT = 'Set it in apps/api/.env (see .env.example) or in the hosting env.';

/** What PUBLIC_BASE_URL looks like, quoted in its error messages. */
const PUBLIC_BASE_URL_EXAMPLE =
  'e.g. https://<your-domain>, or http://localhost:5173 (the Vite dev server) for a local run';

/**
 * The site's public origin from `PUBLIC_BASE_URL`, without a trailing slash: the links in WhatsApp
 * messages are `${origin}/o/<token>`, so they must point at the site the customer can open.
 *
 * Accepts an absolute `http:` or `https:` URL with nothing after the host but an optional `/`:
 * `https://latet-od.example/` → `https://latet-od.example`. A path, query or `#fragment` is refused
 * rather than dropped, because the links would silently lose it; a `user:password@` part is
 * refused because it would be sent to every customer.
 *
 * @throws Error naming PUBLIC_BASE_URL, what is wrong, and an example. The value itself is not a
 *   secret, but it is not repeated either, like every other startup error.
 */
export function parsePublicBaseUrl(value: string | undefined): string {
  if (!value) {
    throw new Error(
      `PUBLIC_BASE_URL is not set: it is the site's address, used in the links inside WhatsApp ` +
        `messages (${PUBLIC_BASE_URL_EXAMPLE}). ${ENV_HINT}`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `PUBLIC_BASE_URL is not an absolute URL: it needs the scheme and host, ${PUBLIC_BASE_URL_EXAMPLE}.`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `PUBLIC_BASE_URL must start with https:// (or http:// for a local run), ${PUBLIC_BASE_URL_EXAMPLE}.`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `PUBLIC_BASE_URL must not contain a user name or password: every customer gets these links. ` +
        `Use only the site's origin, ${PUBLIC_BASE_URL_EXAMPLE}.`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `PUBLIC_BASE_URL must be the site's origin only, with no path, query or #fragment, ` +
        `${PUBLIC_BASE_URL_EXAMPLE}.`,
    );
  }
  return url.origin;
}

/**
 * The {@link MessageSender} named by `MESSAGE_SENDER` (ADR-0003):
 * - unset, empty or `wame`: {@link WaMeLinkSender}, the MVP (Yoel taps "send" on a wa.me link).
 * - `cloud`: reserved for the official WhatsApp Cloud API; it needs a CloudApiSender, which is not
 *   built yet, so it refuses to start rather than fall back to wa.me without saying so.
 *
 * @throws Error for `cloud` and for any other value, naming MESSAGE_SENDER and the allowed values.
 */
export function createMessageSender(kind: string | undefined): MessageSender {
  if (kind === undefined || kind === '' || kind === 'wame') return new WaMeLinkSender();
  if (kind === 'cloud') {
    throw new Error(
      'MESSAGE_SENDER=cloud is not built yet: it needs a CloudApiSender for the WhatsApp Cloud API ' +
        '(ADR-0003). Use MESSAGE_SENDER=wame, or leave it unset.',
    );
  }
  throw new Error(
    'MESSAGE_SENDER is not a known sender: use "wame" (the default when unset; Yoel taps "send" ' +
      `on a wa.me link). "cloud" is reserved for the WhatsApp Cloud API (ADR-0003). ${ENV_HINT}`,
  );
}

/**
 * The {@link MessagingDeps} described by `env` (normally `process.env`): the sender from
 * `MESSAGE_SENDER` ({@link createMessageSender}) and the links' origin from `PUBLIC_BASE_URL`
 * ({@link parsePublicBaseUrl}).
 *
 * @throws Error when either variable is bad; the message names the variable.
 */
export function messagingDepsFromEnv(env: NodeJS.ProcessEnv): MessagingDeps {
  return {
    sender: createMessageSender(env.MESSAGE_SENDER),
    publicBaseUrl: parsePublicBaseUrl(env.PUBLIC_BASE_URL),
  };
}
