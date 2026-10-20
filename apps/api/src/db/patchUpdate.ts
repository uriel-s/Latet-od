// How every repo stores values and applies patches, shared by the Mongo repos and their in-memory
// fakes so the two cannot drift apart: optional fields are absent, never `undefined` or null (the
// zod schemas reject null), and a patch is Mongo's `$set` / `$unset` on top-level fields.
// No driver import: the in-memory fakes use this module too.

/**
 * A deep copy of `value` without object keys whose value is `undefined` (at any depth), like the
 * driver with `ignoreUndefined`, so a repo is right even on a client without that option. Dates
 * are copied too, so what a repo stores shares nothing with the caller.
 */
export function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value instanceof Date) return new Date(value);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, withoutUndefined(field)]),
  );
}

/** The Mongo update document {@link buildPatchUpdate} makes from a patch of type `Patch`. */
export interface PatchUpdate<Patch extends object> {
  $set?: Patch;
  $unset?: Partial<Record<keyof Patch, ''>>;
}

/**
 * The Mongo update for `patch`: a key with a value replaces the field as a whole (`$set`), a key
 * whose value is `undefined` removes it (`$unset`). Inside a `$set` value, nested `undefined`
 * fields are left out. Null for an empty patch: Mongo refuses an empty update.
 */
export function buildPatchUpdate<Patch extends object>(patch: Patch): PatchUpdate<Patch> | null {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) $unset[field] = '';
    else $set[field] = withoutUndefined(value);
  }

  const update: PatchUpdate<Patch> = {};
  // Both objects' keys come from `patch`, so they hold fields of `Patch` only.
  if (Object.keys($set).length > 0) update.$set = $set as Patch;
  if (Object.keys($unset).length > 0) update.$unset = $unset as PatchUpdate<Patch>['$unset'];
  return update.$set === undefined && update.$unset === undefined ? null : update;
}
