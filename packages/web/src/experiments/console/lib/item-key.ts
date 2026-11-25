/**
 * How a person reads an item key (DESIGN.md, "Item keys, everywhere a person reads"). Pack
 * revisions key an issue's item `issue-<number>` or just `<number>`; both read `#<number>`, so
 * one issue has one spelling on every surface. Any other key reads as it is.
 *
 * A split member is keyed `<parent key>-<piece>` (the pack's split forms it so). Given its
 * parent, it reads as the parent and its piece in words: `issue-136-item-keys` in `issue-136`
 * reads `#136 · item keys`. Which parent an item has comes from its `part_of` link, passed in
 * by the caller; it is never read out of the key, so a key that only looks like a member reads
 * as it is.
 *
 * Display only: the key itself is persisted and is the item's route segment, so links,
 * lookups, search and comparisons keep the raw key.
 */

/** The issue number a key names (`issue-123` or `123`, digits as written); null for any other key. */
export function issueNumber(key: string): string | null {
  const match = /^(?:issue-)?(\d+)$/.exec(key);
  return match?.[1] ?? null;
}

/** `#123` for `issue-123` or `123`; `#123 · item keys` for a member of `partOf`; else the key. */
export function displayItemKey(key: string, partOf: string | null = null): string {
  if (partOf !== null && key.startsWith(`${partOf}-`)) {
    const piece = key.slice(partOf.length + 1).replaceAll('-', ' ');
    if (piece.trim() !== '') return `${displayItemKey(partOf)} · ${piece}`;
  }
  const number = issueNumber(key);
  return number === null ? key : `#${number}`;
}
