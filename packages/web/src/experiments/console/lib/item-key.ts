/**
 * How a person reads an item key (DESIGN.md, "Item keys, everywhere a person reads"). Pack
 * revisions key an issue's item `issue-<number>` or just `<number>`; both read `#<number>`, so
 * one issue has one spelling on every surface. Any other key reads as it is.
 *
 * Display only: the key itself is persisted and is the item's route segment, so links,
 * lookups, search and comparisons keep the raw key.
 */
export function displayItemKey(key: string): string {
  const match = /^(?:issue-)?(\d+)$/.exec(key);
  return match?.[1] === undefined ? key : `#${match[1]}`;
}
