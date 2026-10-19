// Hashing of the collector's one password (ADR-0004). scrypt from node:crypto, so there is no
// native dependency to break on Windows or on the host's build (bcrypt's problem). The stored
// value is COLLECTOR_PASSWORD_HASH = `scrypt$<salt>$<hash>`, made by `npm run hash-password`;
// credentials.ts checks a typed password against it.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** First part of every stored hash: names the algorithm, so another one could be added later. */
const SCHEME = 'scrypt';

/**
 * scrypt's cost parameters. They are Node's defaults (N=16384, r=8, p=1: about 50 ms and 16 MB per
 * hash), but pinned here: the stored format carries no parameters, so a Node release that changed
 * its defaults must not silently stop every stored hash from matching.
 */
const SCRYPT_OPTIONS: ScryptOptions = { N: 16384, r: 8, p: 1 };

/** Bytes of random salt per hash: a fresh one each time, so equal passwords hash differently. */
const SALT_BYTES = 16;

/** Bytes of derived key, Node's usual scrypt length. */
const KEY_BYTES = 64;

/** A stored hash split into its binary parts, ready for {@link verifyPassword}. */
export interface ParsedPasswordHash {
  salt: Buffer;
  hash: Buffer;
}

/** scrypt as a promise: the async form, so hashing never blocks the event loop. */
function deriveKey(password: string, salt: Buffer, keyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Hashes a password with a new random salt, as `scrypt$<salt>$<hash>` with both parts base64url
 * without padding: the value for COLLECTOR_PASSWORD_HASH. Only the hash-password script calls it;
 * the api never stores a password.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await deriveKey(password, salt, KEY_BYTES);
  return `${SCHEME}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** The error for a malformed stored hash. `problem` describes the shape, never the value. */
function malformed(problem: string): Error {
  return new Error(
    `Malformed password hash (${problem}): expected "scrypt$<salt>$<hash>" as printed by ` +
      '`npm run hash-password --workspace apps/api`.',
  );
}

/**
 * Decodes one base64url part of a stored hash, or null when it is not exactly `bytes` bytes in
 * canonical base64url. Node's decoder skips characters it does not know and accepts padding, so
 * the text must also round-trip: that rejects typos, `=` padding and stray characters.
 */
function decodePart(text: string, bytes: number): Buffer | null {
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== text) return null;
  return decoded;
}

/**
 * Splits a stored `scrypt$<salt>$<hash>` into its salt and hash. Throws when the value has the
 * wrong shape: not three `$` parts, another scheme, or a part that is not canonical base64url of
 * the right length. The error message never contains the value, which is a secret.
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash {
  const parts = stored.split('$');
  if (parts.length !== 3) throw malformed('not three parts separated by "$"');
  const [scheme = '', saltText = '', hashText = ''] = parts;

  if (scheme !== SCHEME) throw malformed('it does not start with "scrypt$"');
  const salt = decodePart(saltText, SALT_BYTES);
  if (salt === null) throw malformed(`the salt is not ${SALT_BYTES} bytes of base64url`);
  const hash = decodePart(hashText, KEY_BYTES);
  if (hash === null) throw malformed(`the hash is not ${KEY_BYTES} bytes of base64url`);

  return { salt, hash };
}

/**
 * True when `password` hashes, with the stored salt, to the stored hash. The comparison takes the
 * same time whichever byte differs (`timingSafeEqual`), so response times reveal nothing about
 * the hash. The derived key has the stored hash's length, so the lengths always match.
 */
export async function verifyPassword(
  password: string,
  stored: ParsedPasswordHash,
): Promise<boolean> {
  const derived = await deriveKey(password, stored.salt, stored.hash.length);
  return timingSafeEqual(derived, stored.hash);
}
