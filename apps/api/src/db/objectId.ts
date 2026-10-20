// Reading the ids the Mongo repos hand out. Every repo's id is its document's `_id` as a hex
// string, and an id arrives from a URL or a request body, so it is parsed strictly here, once for
// every collection (`orders`, `rounds`).
import { ObjectId } from 'mongodb';

/**
 * The id a repo hands out is the `_id`'s hex string: exactly 24 lowercase hex characters.
 * Stricter than `ObjectId.isValid`, which also accepts any 12-character string; and lowercase only,
 * so a different spelling of an id is unknown here exactly as in the in-memory fakes.
 */
const OBJECT_ID_HEX_PATTERN = /^[0-9a-f]{24}$/;

/**
 * The ObjectId behind a repo id, or null when `id` cannot be one a repo handed out (see
 * {@link OBJECT_ID_HEX_PATTERN}). Repos turn null into "not found": a malformed id from a URL is a
 * miss, never an error.
 */
export function parseObjectId(id: string): ObjectId | null {
  return OBJECT_ID_HEX_PATTERN.test(id) ? ObjectId.createFromHexString(id) : null;
}
