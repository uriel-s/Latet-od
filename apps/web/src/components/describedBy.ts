/** The ids for `aria-describedby`, space-separated; undefined when there is none. */
export function describedBy(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((id) => id !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
}
