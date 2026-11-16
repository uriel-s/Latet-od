/** `ids` with `id` in it (`present`) or out of it; the same set when nothing changes. */
export function withId(
  ids: ReadonlySet<string>,
  id: string,
  present: boolean,
): ReadonlySet<string> {
  if (ids.has(id) === present) return ids;
  const next = new Set(ids);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}
