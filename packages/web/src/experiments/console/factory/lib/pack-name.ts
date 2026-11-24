/**
 * A pack's name as a person reads it, from its id alone: the part after the owner
 * ("owner/name-of-pack"), its separators made spaces, the first letter upper-cased
 * ("Name of pack"). Generic on purpose: no pack is named here. The raw id when nothing
 * readable is left.
 */
export function packDisplayName(id: string): string {
  const name = (id.split('/').at(-1) ?? '').replace(/[-_.]+/g, ' ').trim();
  if (name === '') return id;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
