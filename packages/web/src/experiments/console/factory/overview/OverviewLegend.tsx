import type { ReactElement } from 'react';
import { BACK, LINE, LINE_TO } from '../canvas-lines';
import type { OverviewDeclaration, OverviewView } from '../lib/overview-nav';
import { KINDS } from './overview-kinds';

type EdgeKind = OverviewView['edges'][number]['kind'];

/** Each kind of line in plain words, with a swatch drawn as the map draws it. */
const EDGES: Record<
  EdgeKind,
  { words: string; swatch: 'solid' | 'dotted' | 'dashed'; color: string }
> = {
  feeds: { words: 'hands work on', swatch: 'solid', color: LINE_TO },
  calls: { words: 'asks someone', swatch: 'dotted', color: LINE },
  'loops-back': { words: 'sends work back', swatch: 'dashed', color: BACK },
};

const ITEM = 'flex items-center gap-1.5 text-console-12 text-text-secondary';

/**
 * The kinds of card and line the file uses, in plain words, what a shadow line means when the
 * file has one, and what a ⤢ card does.
 */
export function OverviewLegend({ overview }: { overview: OverviewDeclaration }): ReactElement {
  const views = Object.values(overview.views);
  const kinds = new Set(views.flatMap(view => view.cards.map(card => card.kind)));
  const edges = new Set(views.flatMap(view => view.edges.map(edge => edge.kind)));
  const opens = views.some(view => view.cards.some(card => card.opens !== undefined));
  const shadow = views.some(view => view.edges.some(edge => edge.shadow === true));
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {(Object.keys(KINDS) as (keyof typeof KINDS)[])
        .filter(kind => kinds.has(kind))
        .map(kind => (
          <li key={kind} className={ITEM}>
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-sm"
              style={{ background: KINDS[kind].color }}
            />
            {KINDS[kind].words}
          </li>
        ))}
      {(Object.keys(EDGES) as EdgeKind[])
        .filter(kind => edges.has(kind))
        .map(kind => (
          <li key={kind} className={ITEM}>
            <span
              aria-hidden="true"
              className="inline-block w-5 border-t-2"
              style={{ borderTopStyle: EDGES[kind].swatch, borderTopColor: EDGES[kind].color }}
            />
            {EDGES[kind].words}
          </li>
        ))}
      {shadow ? (
        <li className={ITEM}>
          <span
            aria-hidden="true"
            className="rounded-full border border-dashed px-1.5"
            style={{ borderColor: 'var(--node-opaque)', color: 'var(--node-opaque)' }}
          >
            shadow
          </span>
          would do it, does nothing yet
        </li>
      ) : null}
      {opens ? (
        <li className={ITEM}>
          <span aria-hidden="true">⤢</span>opens a closer look
        </li>
      ) : null}
    </ul>
  );
}
