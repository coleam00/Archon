import type { OverviewCard, OverviewDeclaration } from './overview-nav';

const card = (
  id: string,
  title: string,
  col: number,
  extra: Partial<OverviewCard> = {}
): OverviewCard => ({
  id,
  title,
  text: `What ${title} does.`,
  icon: 'hammer',
  kind: 'stage',
  col,
  row: 1,
  ...extra,
});

/** A small overview: a root of three cards, two of which open views, one of those opening another. */
export const OVERVIEW: OverviewDeclaration = {
  version: 1,
  pack: 'acme/kit',
  title: 'How it works',
  caption: 'Work comes in, is made, and is checked.',
  root: 'top',
  views: {
    top: {
      cards: [
        card('in', 'An issue', 1, { kind: 'input', icon: 'issue' }),
        card('make', 'Make', 2, { opens: 'make' }),
        card('check', 'Check', 3, { kind: 'check', icon: 'check', opens: 'check' }),
      ],
      edges: [
        { from: 'in', to: 'make', kind: 'feeds' },
        { from: 'make', to: 'check', kind: 'feeds' },
        { from: 'check', to: 'make', kind: 'loops-back', label: 'sent back' },
      ],
    },
    make: {
      caption: 'How a change is made.',
      cards: [card('write', 'Write it', 1), card('test', 'Test it', 2, { opens: 'test' })],
      edges: [{ from: 'write', to: 'test', kind: 'feeds' }],
    },
    test: {
      cards: [card('run', 'Run the tests', 1)],
      edges: [],
    },
    check: {
      cards: [card('read', 'Read the change', 1)],
      edges: [],
    },
  },
};
