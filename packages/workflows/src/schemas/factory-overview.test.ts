import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryOverviewSchema, type FactoryOverview } from './factory-overview';

type View = FactoryOverview['views'][string];
type Card = View['cards'][number];

const card = (id: string, col: number, row: number, extra: Partial<Card> = {}): Card => ({
  id,
  title: id,
  text: `The ${id} card.`,
  icon: 'hammer',
  kind: 'stage',
  col,
  row,
  ...extra,
});

/** A root of three cards in a row with a lane from the last back to the middle, and one drill-down. */
function valid(): FactoryOverview {
  return {
    version: 1,
    pack: 'acme/factory',
    title: 'How it works',
    caption: 'Work comes in, gets built, lands.',
    root: 'top',
    views: {
      top: {
        cards: [card('in', 1, 1), card('make', 2, 1, { opens: 'make' }), card('check', 3, 1)],
        edges: [
          { from: 'in', to: 'make', kind: 'feeds' },
          { from: 'make', to: 'check', kind: 'feeds' },
          { from: 'check', to: 'make', kind: 'loops-back', label: 'back' },
        ],
      },
      make: {
        cards: [card('write', 1, 1), card('test', 2, 1)],
        edges: [{ from: 'write', to: 'test', kind: 'feeds' }],
      },
    },
  };
}

/**
 * What `overview` is refused for: each issue's path, then the ids from the input it names (the
 * quoted values in its message), so a test pins the rule and the place, not the wording.
 */
function issues(overview: unknown): string[] {
  const parsed = factoryOverviewSchema.safeParse(overview);
  return (parsed.error?.issues ?? []).map(issue => {
    const named = [...issue.message.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    return [issue.path.join('.'), ...named].join(' ');
  });
}

/** `valid()` changed by `edit`, which changes it in place or returns a replacement. */
function edited(edit: (overview: FactoryOverview) => unknown): unknown {
  const overview = valid();
  return edit(overview) ?? overview;
}

const top = (o: FactoryOverview): View => o.views.top as View;
const make = (o: FactoryOverview): View => o.views.make as View;

const sections = [
  { id: 'held', eyebrow: 'Policies', title: 'Held to', kind: 'stage', icon: 'scale' },
  { id: 'proven', eyebrow: 'Checks', title: 'Proven', kind: 'check', icon: 'flask' },
] as const;
const settings = {
  plan_policy: { points_to: 'policy', section: 'held' },
  checks_file: { points_to: 'checks', shadow: true, section: 'proven', when_live: 'Sends back' },
  validate_command: {},
} as const;
/** An ask from `write` to a person below it, and their reply drawn beside it. */
const asked = (o: FactoryOverview): View => {
  make(o).cards.push(card('you', 1, 2));
  make(o).edges.push(
    { from: 'write', to: 'you', kind: 'calls', label: 'asks' },
    { from: 'you', to: 'write', kind: 'loops-back', label: 'restarts it' }
  );
  return make(o);
};

test('accepts the overview this repository ships, every live-able shadow setting explained', () => {
  const file = join(
    import.meta.dir,
    '../../../../.archon/packs/Wirasm.archon-software-factory.factory-overview.json'
  );
  const overview = JSON.parse(readFileSync(file, 'utf8')) as FactoryOverview;
  expect(issues(overview)).toEqual([]);
  // The Settings page says what changes when a shadow goes live; this file gives every one.
  const unexplained = Object.entries(overview.settings ?? {})
    .filter(([, setting]) => setting.shadow === true && setting.when_live === undefined)
    .map(([name]) => name);
  expect(unexplained).toEqual([]);
});

test.each<[string, (o: FactoryOverview) => unknown]>([
  [
    'the valid overview, settings in sections',
    o => ({ ...o, setting_sections: sections, settings }),
  ],
  ['a reply to an ask, drawn beside it', o => void asked(o)],
])('factoryOverviewSchema accepts %s', (_name, edit) => {
  expect(issues(edited(edit))).toEqual([]);
});

describe('factoryOverviewSchema rejects', () => {
  test('an unknown key, so a misspelled field is not silently dropped', () => {
    const parsed = factoryOverviewSchema.safeParse({ ...valid(), captions: 'x' });
    expect(parsed.error?.issues.map(issue => [issue.code, issue.path])).toEqual([
      ['unrecognized_keys', []],
    ]);
  });

  // One row per rule: what is refused, the change to `valid()`, and its issues. A row marked
  // `some` checks only that its issue is among them: a broken layout often breaks more than one.
  test.each<[string, (o: FactoryOverview) => unknown, string[], 'some'?]>([
    [
      'a setting in an unknown section',
      o => ({ ...o, setting_sections: sections, settings: { plan_policy: { section: 'gone' } } }),
      ['settings.plan_policy.section gone'],
    ],
    ['a root that names no view', o => ({ ...o, root: 'nope' }), ['root nope']],
    [
      'opens naming a missing view',
      o => void ((top(o).cards[0] as Card).opens = 'gone'),
      ['views.top.cards.0.opens gone'],
    ],
    ['a view no card opens', o => void delete (top(o).cards[1] as Card).opens, ['views.make']],
    ['a root without a loops-back edge', o => void top(o).edges.pop(), ['views.top.edges']],
    [
      'two cards in one cell',
      o => void (make(o).cards[1] = card('test', 1, 1)),
      ['views.make.cards.1 write'],
      'some',
    ],
    [
      'a card naming an undeclared group',
      o => void ((top(o).cards[0] as Card).group = 'nope'),
      ['views.top.cards.0.group nope'],
    ],
    [
      'an edge naming nothing',
      o => void make(o).edges.push({ from: 'write', to: 'gone', kind: 'calls' }),
      ['views.make.edges.1.to gone'],
    ],
    [
      'an edge that runs through a card',
      o => void top(o).edges.push({ from: 'in', to: 'check', kind: 'calls' }),
      ['views.top.edges.3 make'],
      'some',
    ],
  ])('%s', (...[_name, edit, expected, some]) => {
    const found = issues(edited(edit));
    if (some === undefined) expect(found).toEqual(expected);
    else expect(found).toEqual(expect.arrayContaining(expected));
  });
});
