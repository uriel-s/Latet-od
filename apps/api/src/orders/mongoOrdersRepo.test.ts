// Unit tests of MongoOrdersRepo's pure parts: ids, documents, queries, updates, the duplicate-key
// mapping and the index specs. No test connects to a database: the class only hands these to the
// driver, and its behaviour against Atlas is checked by hand with the contract suite (outside green).
import { describe, expect, it } from 'vitest';
import { MongoServerError, ObjectId } from 'mongodb';
import { OPEN_ORDER_STATUSES } from '@bottlerun/shared';
import { makeNewOrder } from './makeOrder.ts';
import {
  buildListFilter,
  buildUpdate,
  mapDuplicateKeyError,
  ONE_OPEN_ORDER_PER_PHONE_INDEX,
  ORDER_INDEXES,
  parseOrderId,
  toOrder,
  toOrderDocument,
  TOKEN_UNIQUE_INDEX,
} from './mongoOrdersRepo.ts';
import { DuplicateOpenOrderError } from './ordersRepo.ts';

const HEX_ID = '0123456789abcdef01234567';

/**
 * A duplicate-key error the way the driver reports one: the server's E11000 message, which names
 * the index and quotes the duplicate value, and, unless `withKeyPattern` is false (older servers),
 * `keyPattern` / `keyValue`.
 */
function duplicateKeyError(
  indexName: string,
  field: string,
  value: string,
  withKeyPattern = true,
): MongoServerError {
  return new MongoServerError({
    errmsg: `E11000 duplicate key error collection: bottlerun.orders index: ${indexName} dup key: { ${field}: "${value}" }`,
    code: 11000,
    ...(withKeyPattern && { keyPattern: { [field]: 1 }, keyValue: { [field]: value } }),
  });
}

describe('parseOrderId', () => {
  it('turns a 24-character lowercase hex id into its ObjectId', () => {
    const objectId = parseOrderId(HEX_ID);

    expect(objectId).toBeInstanceOf(ObjectId);
    expect(objectId?.toHexString()).toBe(HEX_ID);
  });

  it.each([
    ['a word', 'nope'],
    ['a path', '../x'],
    ['an empty string', ''],
    ['25 hex characters', `${HEX_ID}8`],
    ['23 hex characters', HEX_ID.slice(1)],
    // ObjectId.isValid accepts any 12-character string as 12 raw bytes.
    ['a 12-character string', 'abcdefghijkl'],
    // The repo hands out lowercase only: another spelling is unknown, as in the in-memory fake.
    ['uppercase hex', HEX_ID.toUpperCase()],
    ['hex with a space', ` ${HEX_ID.slice(1)}`],
  ])('returns null for %s', (_label, id) => {
    expect(parseOrderId(id)).toBeNull();
  });
});

describe('toOrderDocument', () => {
  it('is the order with the given _id', () => {
    const order = makeNewOrder();
    const _id = new ObjectId();

    expect(toOrderDocument(order, _id)).toEqual({ ...order, _id });
  });

  it('leaves out undefined fields at any depth', () => {
    const order = makeNewOrder({ region: undefined });
    order.address.note = undefined;

    const doc = toOrderDocument(order, new ObjectId());

    expect('region' in doc).toBe(false);
    expect('note' in doc.address).toBe(false);
  });

  it('shares nothing with the caller, dates included', () => {
    const order = makeNewOrder();
    const doc = toOrderDocument(order, new ObjectId());

    order.contact.name = 'changed';
    order.createdAt.setTime(0);

    expect(doc.contact.name).toBe('משה כהן');
    expect(doc.createdAt.getTime()).not.toBe(0);
  });
});

describe('toOrder', () => {
  it('maps _id to the hex id and drops _id', () => {
    const _id = ObjectId.createFromHexString(HEX_ID);
    const order = makeNewOrder();

    const result = toOrder({ ...order, _id });

    expect(result).toEqual({ ...order, id: HEX_ID });
    expect('_id' in result).toBe(false);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('reads back what toOrderDocument stores', () => {
    const order = makeNewOrder({ status: 'pending', roundId: 'round-1' });
    const _id = new ObjectId();

    expect(toOrder(toOrderDocument(order, _id))).toEqual({ ...order, id: _id.toHexString() });
  });

  it('rejects a document with null in an optional field', () => {
    const doc = { ...makeNewOrder(), _id: new ObjectId(), roundId: null };

    expect(() => toOrder(doc)).toThrow();
  });

  it('rejects a document missing a required field', () => {
    const doc: Record<string, unknown> & { _id: ObjectId } = {
      ...makeNewOrder(),
      _id: new ObjectId(),
    };
    delete doc.token;

    expect(() => toOrder(doc)).toThrow();
  });

  it('names the broken field in its error, not the value', () => {
    const order = makeNewOrder();
    const phone = '0501234567';
    const doc = { ...order, contact: { ...order.contact, phone }, _id: new ObjectId() };

    let message = '';
    try {
      toOrder(doc);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('phone');
    expect(message).not.toContain(phone.slice(-8));
  });
});

describe('buildListFilter', () => {
  it('matches every order without a filter', () => {
    expect(buildListFilter({})).toEqual({});
  });

  it('filters by statuses with $in', () => {
    expect(buildListFilter({ statuses: ['waiting', 'pending'] })).toEqual({
      status: { $in: ['waiting', 'pending'] },
    });
  });

  it('keeps an empty status list, which matches nothing', () => {
    expect(buildListFilter({ statuses: [] })).toEqual({ status: { $in: [] } });
  });

  it('filters by round as a plain value', () => {
    expect(buildListFilter({ roundId: 'round-1' })).toEqual({ roundId: { $eq: 'round-1' } });
  });

  it('combines status and round', () => {
    expect(buildListFilter({ statuses: ['confirmed'], roundId: 'round-1' })).toEqual({
      status: { $in: ['confirmed'] },
      roundId: { $eq: 'round-1' },
    });
  });
});

describe('buildUpdate', () => {
  it('sets the fields with a value and unsets the undefined ones', () => {
    const updatedAt = new Date('2026-10-19T09:00:00.000Z');

    const update = buildUpdate({ status: 'waiting', roundId: undefined, updatedAt });

    expect(update).toEqual({ $set: { status: 'waiting', updatedAt }, $unset: { roundId: '' } });
  });

  it('has only $set when nothing is removed', () => {
    expect(buildUpdate({ bottlesEstimated: 50 })).toEqual({ $set: { bottlesEstimated: 50 } });
  });

  it('has only $unset when everything is removed', () => {
    expect(buildUpdate({ roundId: undefined, lastMiss: undefined })).toEqual({
      $unset: { roundId: '', lastMiss: '' },
    });
  });

  it('leaves out undefined fields inside a value it sets', () => {
    const address = { ...makeNewOrder().address, note: undefined };

    const update = buildUpdate({ address });

    expect(update?.$set?.address).toEqual(makeNewOrder().address);
    expect('note' in (update?.$set?.address ?? {})).toBe(false);
  });

  it('returns null for an empty patch', () => {
    expect(buildUpdate({})).toBeNull();
  });
});

describe('mapDuplicateKeyError', () => {
  const phone = '+972501234567';
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

  it('maps the phone index to DuplicateOpenOrderError', () => {
    const error = duplicateKeyError(ONE_OPEN_ORDER_PER_PHONE_INDEX, 'contact.phone', phone);

    expect(mapDuplicateKeyError(error)).toBeInstanceOf(DuplicateOpenOrderError);
  });

  it('maps the token index to a plain Error, not DuplicateOpenOrderError', () => {
    const mapped = mapDuplicateKeyError(duplicateKeyError(TOKEN_UNIQUE_INDEX, 'token', token));

    expect(mapped).toBeInstanceOf(Error);
    expect(mapped).not.toBeInstanceOf(DuplicateOpenOrderError);
  });

  it('recognizes the index by name when the server sends no keyPattern', () => {
    const phoneError = duplicateKeyError(
      ONE_OPEN_ORDER_PER_PHONE_INDEX,
      'contact.phone',
      phone,
      false,
    );
    const tokenError = duplicateKeyError(TOKEN_UNIQUE_INDEX, 'token', token, false);

    expect(mapDuplicateKeyError(phoneError)).toBeInstanceOf(DuplicateOpenOrderError);
    expect(mapDuplicateKeyError(tokenError)).not.toBeInstanceOf(DuplicateOpenOrderError);
  });

  it('never carries the phone or the token in what it returns', () => {
    const errors = [
      duplicateKeyError(ONE_OPEN_ORDER_PER_PHONE_INDEX, 'contact.phone', phone),
      duplicateKeyError(TOKEN_UNIQUE_INDEX, 'token', token),
      duplicateKeyError('some_other_index', 'token', token),
    ];

    for (const error of errors) {
      const mapped = mapDuplicateKeyError(error);
      expect(mapped).toBeInstanceOf(Error);
      expect(mapped).not.toBe(error);
      // The raw error is not kept as `cause` either: loggers print causes.
      expect(mapped?.cause).toBeUndefined();
      expect(mapped?.message).not.toContain(phone.slice(-8));
      expect(mapped?.message).not.toContain(token);
    }
  });

  it('maps a duplicate on an unknown index to a plain Error', () => {
    const mapped = mapDuplicateKeyError(duplicateKeyError('some_other_index', 'other', 'x'));

    expect(mapped).toBeInstanceOf(Error);
    expect(mapped).not.toBeInstanceOf(DuplicateOpenOrderError);
  });

  it.each([
    ['another server error', new MongoServerError({ errmsg: 'not primary', code: 10107 })],
    ['a plain Error', new Error('E11000 lookalike')],
    ['a plain object with code 11000', { code: 11000, keyPattern: { 'contact.phone': 1 } }],
    ['undefined', undefined],
  ])('leaves %s alone', (_label, error) => {
    expect(mapDuplicateKeyError(error)).toBeUndefined();
  });
});

describe('ORDER_INDEXES', () => {
  it('makes the token unique', () => {
    const tokenIndex = ORDER_INDEXES.find((index) => index.name === TOKEN_UNIQUE_INDEX);

    expect(tokenIndex).toMatchObject({ key: { token: 1 }, unique: true });
    expect(tokenIndex?.partialFilterExpression).toBeUndefined();
  });

  it('makes the phone unique among open orders only', () => {
    const phoneIndex = ORDER_INDEXES.find((index) => index.name === ONE_OPEN_ORDER_PER_PHONE_INDEX);

    expect(phoneIndex).toMatchObject({ key: { 'contact.phone': 1 }, unique: true });
    expect(phoneIndex?.partialFilterExpression).toEqual({
      status: { $in: [...OPEN_ORDER_STATUSES] },
    });
  });
});
