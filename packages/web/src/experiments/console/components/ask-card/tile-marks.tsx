import type { CSSProperties, ReactElement } from 'react';

// The two marks an option can carry (DESIGN.md, Visual standard rule 9; owner change 2026-11-19
// point 1). Recommended is green and never looks chosen; selected is the accent border with a
// check, and depends only on the pick.
//
// Border colours go in `style`, not a `border-*` utility: theme.css sets `border-color` on
// `.console-root *` outside any cascade layer, which outranks every Tailwind (layered) border
// colour in the console, so a utility here would render the neutral `--border`.
export const RECOMMENDED_BG = 'bg-[color:var(--success-soft)]';
const RECOMMENDED_BORDER = 'color-mix(in oklab, var(--success) 40%, transparent)';
const SELECTED_BORDER = 'var(--accent)';

export type Mark = 'selected' | 'recommended';

/**
 * The mark a tile shows, as props to spread on it: `data-mark` names it and `style` draws its
 * border. Selected wins over recommended, so a tile never carries both borders.
 */
export function markProps(
  picked: boolean,
  recommended: boolean
): { 'data-mark'?: Mark; style?: CSSProperties } {
  if (picked) return { 'data-mark': 'selected', style: { borderColor: SELECTED_BORDER } };
  if (recommended)
    return { 'data-mark': 'recommended', style: { borderColor: RECOMMENDED_BORDER } };
  return {};
}

export function RecommendedBadge(): ReactElement {
  return <span className="shrink-0 text-console-12 font-medium text-success">Recommended</span>;
}
