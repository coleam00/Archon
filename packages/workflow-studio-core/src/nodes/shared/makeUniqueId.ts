/**
 * Pick a free id by appending `-2`, `-3`, … to `hint` until it doesn't collide.
 * Pure — no React, no store. Used by drag-drop, click-to-add, and snippet insertion.
 */
export function makeUniqueId(hint: string, existing: ReadonlySet<string>): string {
  if (!existing.has(hint)) return hint;
  let n = 2;
  while (existing.has(`${hint}-${n}`)) n += 1;
  return `${hint}-${n}`;
}
