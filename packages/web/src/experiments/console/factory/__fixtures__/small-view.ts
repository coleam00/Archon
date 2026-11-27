import type { ViewFile } from '../api';

/*
 * A small view file, written by hand for the factory console's tests, drawn over `smallGraph`
 * (`small-pack.ts`): a root How it works picture with parallel inputs, send-backs and an ask,
 * and two drill-downs, `build` and `checks`, the second with three parallel checks.
 * `scripts/check-factory-view.test.ts` checks that it reads clean against that graph.
 */

type Picture = ViewFile['howItWorks']['views'][string];
type Card = Picture['cards'][number];
type Edge = Picture['edges'][number];

const card = (
  id: string,
  kind: Card['kind'],
  col: number,
  row: number,
  rest: Partial<Card> = {}
): Card => ({ id, title: id, text: `What ${id} does`, icon: 'hammer', kind, col, row, ...rest });
const feeds = (from: string, to: string): Edge => ({ from, to, kind: 'feeds' });
const back = (from: string, to: string, label: string): Edge => ({
  from,
  to,
  kind: 'loops-back',
  label,
});

const factory: Picture = {
  groups: [{ id: 'inputs', label: 'Where work comes from' }],
  cards: [
    card('issue', 'input', 1, 1, { group: 'inputs', icon: 'issue' }),
    card('order', 'input', 1, 2, { group: 'inputs', icon: 'order' }),
    card('found', 'input', 1, 3, { group: 'inputs', icon: 'search' }),
    card('triage', 'stage', 2, 2, { stages: ['triage'] }),
    card('link', 'stage', 3, 2, { stages: ['link'] }),
    card('plan', 'stage', 4, 2, { stages: ['plan'] }),
    card('build', 'stage', 5, 2, { opens: 'build', stages: ['stage-build'] }),
    card('checks', 'check', 6, 2, { opens: 'checks', stages: ['stage-check'] }),
    card('ci', 'check', 7, 2, { stages: ['stage-host'] }),
    card('ready', 'outcome', 8, 2, { stages: ['landgate', 'land'] }),
    card('landed', 'outcome', 9, 2, { stages: ['landed'] }),
    card('you', 'person', 4, 1, { icon: 'users' }),
  ],
  edges: [
    feeds('inputs', 'triage'),
    feeds('triage', 'link'),
    feeds('link', 'plan'),
    feeds('plan', 'build'),
    feeds('build', 'checks'),
    feeds('checks', 'ci'),
    feeds('ci', 'ready'),
    feeds('ready', 'landed'),
    { from: 'plan', to: 'you', kind: 'calls', label: 'asks' },
    back('you', 'plan', 'your answer restarts it'),
    back('checks', 'build', 'sent back to fix'),
    back('ci', 'build', 'CI found something'),
    back('build', 'plan', 'replan'),
    back('ci', 'found', 'new work'),
  ],
};

const build: Picture = {
  cards: [
    card('build-plan', 'input', 1, 1, { stages: ['plan'] }),
    card('build-build', 'stage', 2, 1, { stages: ['stage-build'] }),
    card('build-pr', 'outcome', 3, 1),
  ],
  edges: [
    feeds('build-plan', 'build-build'),
    feeds('build-build', 'build-pr'),
    back('build-build', 'build-plan', 'replan'),
  ],
};

const checks: Picture = {
  groups: [{ id: 'checks-three', label: 'Three checks' }],
  cards: [
    card('checks-pr', 'input', 1, 2),
    card('checks-review', 'check', 2, 1, { group: 'checks-three' }),
    card('checks-tests', 'check', 2, 2, { group: 'checks-three' }),
    card('checks-product', 'check', 2, 3, { group: 'checks-three' }),
    card('checks-verdict', 'gate', 3, 2, { stages: ['stage-check'] }),
    card('checks-approved', 'outcome', 4, 2),
    card('checks-build', 'stage', 1, 3, { stages: ['stage-build'] }),
    card('checks-plan', 'stage', 4, 3, { stages: ['plan'] }),
  ],
  edges: [
    feeds('checks-pr', 'checks-three'),
    feeds('checks-three', 'checks-verdict'),
    feeds('checks-verdict', 'checks-approved'),
    back('checks-verdict', 'checks-build', 'sent back to fix'),
    back('checks-verdict', 'checks-plan', 'replan'),
  ],
};

export const smallViewFile: ViewFile = {
  version: 1,
  summary: 'Work comes in, is triaged, linked, planned, built, checked and merged.',
  howItWorks: {
    title: 'How the factory works',
    caption: 'Work comes in, and the factory takes it from triage to a merged change.',
    root: 'factory',
    views: { factory, build, checks },
  },
};
