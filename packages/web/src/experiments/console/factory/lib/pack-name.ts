/**
 * A pack's name as a person reads it, from its id alone: the part after the owner
 * ("owner/name-of-pack"), its separators made spaces, the first letter upper-cased
 * ("Name of pack"). Generic on purpose: no pack is named here. The raw id when nothing
 * readable is left. Ported from v1 (origin/main `factory/lib/pack-name.ts`).
 */
export function packDisplayName(id: string): string {
  const name = (id.split('/').at(-1) ?? '').replace(/[-_.]+/g, ' ').trim();
  if (name === '') return id;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The `owner/name` an installed pack's key (`owner.name`, as routes and projects carry it)
 * stands for: a GitHub owner holds no `.`, so the first `.` is the separator. A key with no `.`
 * is a pack's folder name and is its own id.
 */
export function packIdOfKey(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : `${key.slice(0, dot)}/${key.slice(dot + 1)}`;
}
