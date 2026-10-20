// Unit tests of the value and patch helpers every repo shares (Mongo repos and in-memory fakes).
import { describe, expect, it } from 'vitest';
import { buildPatchUpdate, withoutUndefined } from './patchUpdate.ts';

interface Thing {
  name?: string;
  count?: number;
  when?: Date;
  nested?: { kept: string; dropped?: string };
}

describe('withoutUndefined', () => {
  it('leaves out undefined keys at any depth, inside arrays too', () => {
    const value = { a: 1, b: undefined, c: { d: undefined, e: 'x' }, f: [{ g: undefined, h: 2 }] };

    expect(withoutUndefined(value)).toEqual({ a: 1, c: { e: 'x' }, f: [{ h: 2 }] });
    expect('b' in (withoutUndefined(value) as object)).toBe(false);
  });

  it('keeps null and other plain values as they are', () => {
    expect(withoutUndefined({ a: null, b: 0, c: '' })).toEqual({ a: null, b: 0, c: '' });
    expect(withoutUndefined('text')).toBe('text');
  });

  it('copies objects, arrays and dates, sharing nothing with the input', () => {
    const when = new Date('2026-11-12T08:00:00.000Z');
    const input = { list: [1], when };

    const copy = withoutUndefined(input) as typeof input;
    input.list.push(2);
    when.setTime(0);

    expect(copy).toEqual({ list: [1], when: new Date('2026-11-12T08:00:00.000Z') });
    expect(copy.when).toBeInstanceOf(Date);
  });
});

describe('buildPatchUpdate', () => {
  it('sets the fields with a value and unsets the undefined ones', () => {
    const when = new Date('2026-11-12T08:00:00.000Z');

    expect(buildPatchUpdate<Thing>({ name: 'x', count: undefined, when })).toEqual({
      $set: { name: 'x', when },
      $unset: { count: '' },
    });
  });

  it('has only $set when nothing is removed, and only $unset when everything is', () => {
    expect(buildPatchUpdate<Thing>({ count: 3 })).toEqual({ $set: { count: 3 } });
    expect(buildPatchUpdate<Thing>({ name: undefined })).toEqual({ $unset: { name: '' } });
  });

  it('leaves out undefined fields inside a value it sets', () => {
    const update = buildPatchUpdate<Thing>({ nested: { kept: 'k', dropped: undefined } });

    expect(update).toEqual({ $set: { nested: { kept: 'k' } } });
    expect('dropped' in (update?.$set?.nested ?? {})).toBe(false);
  });

  it('returns null for an empty patch', () => {
    expect(buildPatchUpdate<Thing>({})).toBeNull();
  });
});
