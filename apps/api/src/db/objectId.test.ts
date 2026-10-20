// Unit tests of the strict id parsing every Mongo repo uses.
import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { parseObjectId } from './objectId.ts';

const HEX_ID = '0123456789abcdef01234567';

describe('parseObjectId', () => {
  it('turns a 24-character lowercase hex id into its ObjectId', () => {
    const objectId = parseObjectId(HEX_ID);

    expect(objectId).toBeInstanceOf(ObjectId);
    expect(objectId?.toHexString()).toBe(HEX_ID);
  });

  it.each([
    ['a word', 'nope'],
    ['an empty string', ''],
    ['25 hex characters', `${HEX_ID}8`],
    // ObjectId.isValid accepts any 12-character string as 12 raw bytes.
    ['a 12-character string', 'abcdefghijkl'],
    // Repos hand out lowercase only: another spelling is unknown, as in the in-memory fakes.
    ['uppercase hex', HEX_ID.toUpperCase()],
  ])('returns null for %s', (_label, id) => {
    expect(parseObjectId(id)).toBeNull();
  });
});
