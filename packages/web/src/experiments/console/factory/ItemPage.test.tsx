import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryItemDetail, FactoryViews } from '../skills/factory';
import type { AttentionQueue } from '../skills/runs';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from '../routes/project-routes';
import { itemDetail, PROJECT, shippedListed, shippedView } from './item-detail.test-fixtures';
import { FIXTURE_NOW, declaredAwaits } from './lib/board.test-fixtures';
import { PILL_CLASS } from './BoardCard';
import { itemPill } from './lib/board';
import { askItem } from '../lib/needs-you.test-fixtures';
import { WORK_ORDER_WORDS } from './ItemWorkOrder';
import { formatDateTime } from '../lib/format';
import { Window } from 'happy-dom';
import { documentPageProblems } from './document.test-helpers';
import { firstSentence } from './lib/item-story';

// The board sets aside items idle past a line counted from now, so the fixtures' items are read
// at the time they were copied, never at the day the test runs.
beforeAll(() => {
  setSystemTime(FIXTURE_NOW);
});
afterAll(() => {
  setSystemTime();
});

afterEach(() => {
  invalidate('factory-views');
  invalidate('factory-items');
  invalidate('project');
  invalidate('runs');
});

const listing: FactoryViews = {
  views: [shippedListed],
  errors: [],
};
const quiet: AttentionQueue = { items: [], runs: [], degraded: [] };

function render(detail: FactoryItemDetail, attention: AttentionQueue = quiet): string {
  const key = detail.item.item.key;
  set(K.factoryViews(PROJECT), listing);
  set(K.projectAttention(PROJECT), attention);
  set(K.factoryItem(PROJECT, key), detail);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/console/p/${PROJECT}/factory/items/${key}`]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
}

/** The header's pill, as the board's card draws it: one class map for both. */
const pill = (state: keyof typeof PILL_CLASS, words: string): string =>
  `${PILL_CLASS[state]}">${words}<`;

/** The page's visible words, tags dropped. */
const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ');

/** The markup of the page's section labelled `label`: the band ("Summary") or the strip. */
const section = (html: string, label: string): string =>
  new RegExp(`aria-label="${label}"[^>]*>([^]*?)</section>`).exec(html)?.[1] ?? '';

/** The markup of the story's first panel of `stage`, up to the next panel. */
const panel = (html: string, stage: string): string =>
  new RegExp(`data-story-panel="${stage}"([^]*?)(data-story-panel=|$)`).exec(html)?.[1] ?? '';

/** Each story panel's stage and its opening sentence, as a person reads it. */
const sentences = (html: string): string[][] =>
  [
    ...html.matchAll(
      /data-story-panel="([a-z-]+)"[\s\S]*?data-story-sentence=""[^>]*>([\s\S]*?)<\/p>/g
    ),
  ].map(m => [
    m[1] ?? '',
    text(m[2] ?? '')
      .replace(/\s+([.:;,])/g, '$1')
      .trim()
      .replace(/ (Less|More)$/, ''),
  ]);

/** The band's stat chips, as a person reads each. */
const chips = (html: string): string[] =>
  [...section(html, 'Summary').matchAll(/data-stat-chip="[a-z-]+"[^>]*>(.*?)<\/li>/g)].map(m =>
    text(m[1] ?? '').trim()
  );

/** What each cell of a grid row reads, as words. */
const words = (html: string, row: string): string[] =>
  [
    ...(new RegExp(`data-grid-row="${row}"([^]*?)</tr>`).exec(html)?.[1] ?? '').matchAll(
      /<td[^>]*>([\s\S]*?)<\/td>/g
    ),
  ].map(m => text(m[1] ?? '').trim());

/** What each cell of a grid row says, by its meaning; `absent` for "Not run". */
const cells = (html: string, row: string): string[] =>
  [
    ...(new RegExp(`data-grid-row="${row}"([^]*?)</tr>`).exec(html)?.[1] ?? '').matchAll(
      /data-cell="([a-z]+)"/g
    ),
  ].map(m => m[1] ?? '');

/** The static markup as a document, for the document-page rules. */
function parse(html: string): Element {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document.body as unknown as Element;
}

describe('the item page', () => {
  test('a document page: a header band, the journey, the story and an aside, all on panels', () => {
    for (const key of ['111', '86', '113', '125', '3', '6'] as const) {
      const page = parse(render(itemDetail(key)));
      expect(page.querySelector('[data-doc-page]')).not.toBeNull();
      expect(documentPageProblems(page)).toEqual([]);
    }
  });

  test('item 111: the band says merged, the time from order to merge, cost, rounds and asks', () => {
    const band = section(render(itemDetail('111')), 'Summary');
    expect(band).toContain(pill('landed', 'Merged'));
    expect(text(band)).toContain('#111');
    expect(text(band)).toContain('PR #112');
    expect(text(band)).toContain('Its change merged.');
    const chips = [...band.matchAll(/data-stat-chip="[a-z-]+"[^>]*>(.*?)<\/li>/g)].map(m =>
      text(m[1] ?? '').trim()
    );
    expect(chips).toEqual([
      '1 h 6 min order to merge',
      '$21.94 cost',
      '2 of 3 check rounds',
      '0 asks answered',
    ]);
  });

  test("item 111's journey: each column's time, the loop back from the checks, Merged lit", () => {
    const strip = section(render(itemDetail('111')), 'Journey');
    const segments = [...strip.matchAll(/data-journey-segment="([a-z-]+)"(.*?)<\/li>/g)].map(m => [
      m[1],
      text(`<${m[2] ?? ''}`).trim(),
    ]);
    expect(segments).toEqual([
      ['intake', 'Intake 1 min'],
      ['plan-build', 'Plan & build 39 min'],
      ['checks-review', 'Checks & review 22 min sent back 1x to Plan & build'],
      ['ready', 'Ready to merge 3 min'],
      ['merged', 'Merged Merged It is here now'],
    ]);
    expect(strip).toMatch(/data-journey-segment="merged" data-lit=""/);
  });

  test("item 111's story: one panel per stage, each opening with its sentence", () => {
    const html = render(itemDetail('111'));
    expect(sentences(html)).toEqual([
      ['order', 'Order took the work order and made it an item.'],
      ['triage', 'Triage judged it worth building.'],
      ['plan', 'Plan wrote the approach.'],
      ['build', 'Build wrote the change and opened PR #112.'],
      ['checks', 'Checks sent it back once, then approved it.'],
      ['host', 'The checks and CI passed; it is ready to merge.'],
      ['drain', 'The factory looked for other work it noticed.'],
      ['ready', 'The merge gate read the change.'],
      // Merged by a person: no run told it, so the console says only that it merged.
      ['merged', `The change merged ${formatDateTime('2026-11-20T21:29:51Z')}.`],
    ]);
    // A stage's details: when, how long, cost and model, in a definition grid.
    expect(text(html)).toContain('Model claude-opus-5-5');
    const order = text(panel(html, 'order'));
    expect(order).toContain('Took 14 s');
    expect(order).toContain('Cost Not recorded');
    // The deliver run's one cost, on each panel it worked, said to be the whole run's.
    expect(text(panel(html, 'build'))).toContain('Took 20 min');
    expect(text(panel(html, 'build'))).toContain(
      'Cost $18.14 for the whole run, across its stages'
    );
  });

  test("item 111's checks as a grid: icon and word per cell, the legend, why round 1 came back", () => {
    const html = render(itemDetail('111'));
    expect(text(html)).toContain(
      'Sent back : a check found something to fix and returned the change to the builder. Approved : the check passed.'
    );
    expect(cells(html, 'Code review')).toEqual(['returned', 'approved']);
    expect(cells(html, 'Verdict')).toEqual(['returned', 'approved']);
    expect(cells(html, 'Build')).toEqual(['fixed', 'absent']);
    expect(cells(html, 'CI and review')).toEqual(['absent', 'approved']);
    // Each cell is an icon and a word, never a colour alone.
    expect(words(html, 'Code review')).toEqual(['Sent back', 'Approved']);
    expect(words(html, 'Build')).toEqual(['Fixed', 'Not run']);
    expect(text(html)).toMatch(/Round 1: \S/);
    // The chip rows are gone: no round line.
    expect(text(html)).not.toContain('round 1 of 3 ·');
  });

  test('item 113: the ask in the Build panel, what you chose, who, and what it started', () => {
    const build = panel(render(itemDetail('113')), 'build');
    expect(text(build)).toContain('You said Send back');
    expect(build).toMatch(/data-id-tag=""[^>]*>send-back</);
    expect(text(build)).toContain('by cole-owner');
    expect(build).toContain('data-started="Build started again"');
    const ask = itemDetail('113').item.answers.find(answer => answer.kind === 'ask');
    expect(text(build)).toContain(ask?.kind === 'ask' ? ask.question : 'no question');
    // Two deliveries on one panel: its cost is theirs, not "the whole run".
    expect(text(build)).toContain('for its 2 runs, across their stages');
    expect(chips(render(itemDetail('113')))).toContain('1 ask answered');
  });

  test("item 125 answered reshape: the view's sentence for what it started, not the stage", () => {
    const detail = structuredClone(itemDetail('125'));
    detail.item.answers = detail.item.answers.map(answer =>
      answer.kind === 'ask' && answer.chosen?.id === 'take-as-is'
        ? { ...answer, chosen: { id: 'reshape', does: 'The change stays open as a draft.' } }
        : answer
    );
    const checks = panel(render(detail), 'checks');
    expect(text(checks)).toContain('You said Reshape');
    expect(checks).toContain('data-started="Leaves the PR as a draft until the item is shaped"');
    expect(checks).not.toContain('data-started="CI and review started again"');
  });

  test('item 125, the three-stage delivery: four rounds, then the asks that took it on', () => {
    const html = render(itemDetail('125'));
    const checks = panel(html, 'checks');
    expect(sentences(html)).toContainEqual([
      'checks',
      'Checks sent it back 3 times, then asked you; you said Take as is.',
    ]);
    expect(
      [...checks.matchAll(/scope="col"[^>]*>(.*?)<\/th>/g)].map(m => text(m[1] ?? '').trim())
    ).toEqual(['Check', 'Round 1 of 3', 'Round 2 of 3', 'Round 3 of 3', 'Round 4 of 4']);
    expect(checks).toContain('data-started="CI and review started again"');
    const strip = section(html, 'Journey');
    expect(text(strip)).toContain('sent back 4x to Plan & build');
    expect(strip).toContain('data-journey-pause="answered"');
    // A pause says how long it waited.
    expect(text(strip)).toMatch(/waited on you \d+ min/);
    // A stage met again is its own panel, numbered.
    expect(html).toMatch(/<h2 id="story-plan:2"[^>]*>Plan \(2\)<\/h2>/);
    expect(html).toMatch(/<h2 id="story-triage:2"[^>]*>Triage \(2\)<\/h2>/);
  });

  test('item 125: the CI panel says why CI sent it back and how the builder fixed it', () => {
    const ci = text(panel(render(itemDetail('125')), 'host'));
    expect(ci).toContain('CI and the reviews passed.');
    expect(ci).toMatch(/Sent back: \S/);
    expect(ci).toContain('Build fixed what CI and the reviews raised');
  });

  test('rounds read by their order on the item, though two runs recorded round 1', () => {
    const detail = structuredClone(itemDetail('125'));
    const round = detail.runs.find(run => run.runId.startsWith('bb11ef33'))?.rounds?.rounds[0];
    if (round === undefined) throw new Error('125 has a second round');
    round.iteration = 1;
    const checks = panel(render(detail), 'checks');
    expect(
      [...checks.matchAll(/scope="col"[^>]*>(.*?)<\/th>/g)].map(m => text(m[1] ?? '').trim())
    ).toEqual(['Check', 'Round 1 of 3', 'Round 2 of 3', 'Round 3 of 3', 'Round 4 of 4']);
    // The reasons under the grid take the same numbers.
    const reasons = text(checks).match(/Round \d+:/g);
    expect(reasons).toEqual(['Round 1:', 'Round 2:', 'Round 3:']);
  });

  test('a panel that sent the item back ends its sentence on why, the rest behind More', () => {
    const detail = structuredClone(itemDetail('125'));
    const third = detail.item.runs.findIndex(run => run.id.startsWith('bb11ef33'));
    detail.item.runs = detail.item.runs.slice(0, third + 1);
    detail.item.answers = [];
    const summary =
      detail.runs.find(run => run.runId.startsWith('bb11ef33'))?.rounds?.rounds[0]?.summary ?? '';
    const [, checks] = sentences(render(detail)).find(([stage]) => stage === 'checks') ?? [];
    expect(checks).toBe(
      `Checks sent it back twice: ${firstSentence(summary).replace(/[.!?…]$/, '')}.`
    );
  });

  test('item 86, parked: the journey stops in Intake, saying so; the rest not reached', () => {
    const html = render(itemDetail('86'));
    expect(section(html, 'Summary')).toContain(pill('parked', 'Parked'));
    const strip = text(section(html, 'Journey'));
    expect(strip).toContain('Stopped here: Parked by triage');
    expect(strip.match(/Not reached/g)).toHaveLength(4);
    expect(chips(html)[0]).toBe('1 min order to where it stopped');
    expect(sentences(html)).toContainEqual(['triage', 'Triage parked it for later.']);
  });

  test('item 86 had triage asked for shaping: Needs shaping, soft, with the questions to settle', () => {
    const detail = structuredClone(itemDetail('86'));
    const progress = detail.item.progress;
    const triage = detail.item.runs.at(-1);
    if (progress === null || triage === undefined) throw new Error('item 86 has a triage run');
    triage.outcome = 'shape';
    progress.parked = null;
    progress.awaits = declaredAwaits('triage:shape', 'Worth doing once the scope is settled.', [
      'Which surfaces does it touch?',
      'Is it one change or two?',
    ]);
    const html = render(detail);
    // The soft needs-you pill in the item's own words; only an open ask's pill is filled.
    expect(section(html, 'Summary')).toContain(pill('awaits', 'Needs shaping'));
    expect(text(section(html, 'Summary'))).toContain(
      'Needs shaping: Worth doing once the scope is settled.'
    );
    expect(text(section(html, 'Journey'))).toContain('Stopped here: Needs shaping');
    const panel = /data-awaits=""[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    expect(text(panel)).toContain('Questions to settle');
    expect(text(panel)).toContain('Which surfaces does it touch?');
    expect(text(panel)).toContain('Is it one change or two?');
    // Nothing here is answered in place: the view says what moves the item on.
    expect(text(panel)).toContain(
      `What to do ${shippedView.awaits?.['triage:shape']?.next ?? '?'}`
    );
    expect(panel).not.toContain('data-ping');
    expect(sentences(html)).toContainEqual([
      'triage',
      'Triage judged it worth doing, once a maintainer settles its open questions.',
    ]);
  });

  test('item 6 runs: the Running pill, and its stage working on it now, by step name', () => {
    const html = render(itemDetail('6'));
    expect(html).toContain(pill('running', 'Running'));
    expect(sentences(html)).toContainEqual([
      'build',
      'Build is working on it now: Writes the change.',
    ]);
    expect(text(html)).toContain('No change yet');
    expect(chips(html)[0]).toMatch(/ order to now$/);
  });

  test('item 3: every ask answered and nothing started; it stops there, saying so', () => {
    const html = render(itemDetail('3'));
    expect(text(section(html, 'Summary'))).toContain(
      'Nothing started after your answer, in Build.'
    );
    expect(chips(html)[0]).toMatch(/ order to where it stopped$/);
    expect(text(section(html, 'Journey'))).toContain(
      'Stopped here: Nothing started after your answer'
    );
    expect(section(html, 'Journey')).not.toContain('data-lit');
  });

  test('the header: the PR as a button-style link, its merge state as quiet words', () => {
    const merged = render(itemDetail('1'));
    expect(merged).toMatch(
      /class="inline-flex[^"]*rounded-md border border-border[^"]*"><svg[^>]*lucide-git-pull-request/
    );
    // A merged item says so once: its pill, then the PR with a quiet "merged". No "In Merged",
    // which only repeated the pill.
    expect(merged).toContain(pill('landed', 'Merged'));
    expect(text(merged)).not.toContain('In Merged');
    expect(merged).toContain(
      'data-merge-state="true" class="whitespace-nowrap text-console-13 text-text-tertiary">merged<'
    );
    expect(render(itemDetail('3'))).toContain('data-merge-state="unknown"');
    const detail = itemDetail('3');
    const change = detail.item.progress?.change;
    if (change === undefined || change === null) throw new Error('item 3 has a change');
    const withMerged = (value: typeof change.merged): FactoryItemDetail => ({
      ...detail,
      item: {
        ...detail.item,
        progress:
          detail.item.progress === null
            ? null
            : { ...detail.item.progress, change: { ...change, merged: value } },
      },
    });
    expect(render(withMerged(false))).toContain(
      'data-merge-state="false" class="whitespace-nowrap text-console-13 text-text-tertiary">open<'
    );
    const pending = render(withMerged('pending'));
    expect(pending).toContain('data-merge-state="pending"');
    expect(pending).toContain('data-skeleton="line"');
    expect(pending).toContain('<span class="sr-only">checking whether it merged</span>');
  });

  test('while the item is read: the header and three runs as skeletons, never Loading', () => {
    set(K.factoryViews(PROJECT), listing);
    set(K.projectAttention(PROJECT), quiet);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/console/p/${PROJECT}/factory/items/77`]}>
        <Routes>{projectRoutes('/console/')}</Routes>
      </MemoryRouter>
    );
    expect(html).toContain('<span class="sr-only">Loading the item</span>');
    expect(html.match(/data-skeleton="block" class="[^"]*h-16/g)?.length).toBe(3);
    expect(html).not.toContain('Loading…');
  });

  test("lists only this item's asks from the live queue, answerable, and says it needs you", () => {
    // Item 3: its change has not merged, so an open ask is what its pill says.
    const detail = itemDetail('3');
    const mine = askItem({ ref: 'ask:mine', item: { ...detail.item.item } });
    // A wait in a child run names no item; the item read lists it among its questions.
    const child = askItem({ ref: 'ask:child', item: undefined, message: 'From the child run?' });
    const other = askItem({ ref: 'ask:other', message: 'Not this item?' });
    const read = { ...detail, item: { ...detail.item, questions: [child] } };
    const html = render(read, { items: [mine, child, other], runs: [], degraded: [] });
    const words = text(html);
    // The header pill, not the project's Needs you tab that prints the same words on every page.
    expect(html).toContain(pill('needs-you', 'Needs you'));
    expect(words).toContain('Which base should the change target?');
    expect(words).toContain('From the child run?');
    expect(words).not.toContain('Not this item?');
    // Each as the ask card, always open: its tiles, the recommended one first, answerable.
    expect(html.split('data-ask=')).toHaveLength(3);
    expect(words).toContain('Use dev Recommended Rebases onto dev.');
    expect(html.split('aria-pressed="false"').length - 1).toBe(4);
  });

  test("an open stage ask's drop tile says what it starts, in the view's words", () => {
    const detail = itemDetail('3');
    const ask = askItem({
      ref: 'ask:drop',
      item: { ...detail.item.item },
      askedIn: { runId: 'run-check', workflow: 'Wirasm/archon-software-factory:stage-check' },
      options: [{ id: 'drop', does: 'Closes it.' }],
      recommendation: { option: 'drop', why: 'It is done.' },
    });
    const html = render(detail, { items: [ask], runs: [], degraded: [] });
    expect(html).toMatch(/data-starts=""[^>]*>[\s\S]*?Closes the PR without merging/);
  });

  test('an open ask on a running item: Needs you, as its board card says', () => {
    const detail = itemDetail('6');
    const ask = askItem({ ref: 'ask:open', item: { ...detail.item.item } });
    const read = { ...detail, item: { ...detail.item, questions: [ask] } };
    expect(itemPill(shippedView, read.item, false).pill).toBe('needs-you');
    const html = render(read, { items: [ask], runs: [], degraded: [] });
    expect(html).toContain(pill('needs-you', 'Needs you'));
    expect(html).not.toContain(pill('running', 'Running'));
  });

  test('links in plain words, both directions, an ended one marked', () => {
    const detail = itemDetail('1');
    const act = { at: '2026-11-17T00:00:00.000Z', via: 'cli' as const, by: null, fromRun: null };
    const other = (key: string) => ({ id: `item-${key}`, projectKey: 'p', key });
    const links: FactoryItemDetail['item']['links'] = [
      {
        id: 'l1',
        kind: 'depends_on',
        direction: 'outgoing',
        other: other('4'),
        ...act,
        ended: null,
      },
      { id: 'l2', kind: 'part_of', direction: 'incoming', other: other('9'), ...act, ended: act },
    ];
    const html = render({ ...detail, item: { ...detail.item, links } });
    const words = text(html);
    expect(words).toContain('Depends on #4');
    expect(words).toContain('Has part #9 ended');
    expect(html).toContain(`href="/console/p/${PROJECT}/factory/items/4"`);
  });
});

describe('work orders on the item page', () => {
  const act = { at: '2026-11-17T00:00:00.000Z', via: 'cli' as const, by: null, fromRun: null };
  type Item = FactoryItemDetail['item'];
  const partOf = (item: Item, order: string): Item => ({
    ...item,
    links: [
      {
        id: `link-${item.item.key}`,
        kind: 'part_of',
        direction: 'outgoing',
        other: { id: `item-${order}`, projectKey: item.item.projectKey, key: order },
        ...act,
        ended: null,
      },
    ],
  });
  /** The board's items read: `items`, and the members of each order it read. */
  const itemsRead = (items: Item[], members: Record<string, string[]> = {}): void => {
    set(K.factoryItems(PROJECT), { items, members });
  };

  test('a member its order run placed, with no link: Part of the order it named', () => {
    const detail = itemDetail('3');
    const item = { ...detail.item, progress: { ...detail.item.progress!, partOf: '48' } };
    itemsRead([item]);
    const html = render({ ...detail, item });
    expect(text(html)).toContain('Part of #48 as its order run recorded');
    expect(html).toContain(`href="/console/p/${PROJECT}/factory/items/48"`);
    expect(text(html)).not.toContain('No links to other items.');
  });

  test('an order with runs of its own: its members, with their state, and how many merged', () => {
    const base = itemDetail('1');
    // 3's link stands as the member; 9's, whose newer link names another order, stays a link.
    const incoming = (key: string) => ({
      id: `link-${key}`,
      kind: 'part_of' as const,
      direction: 'incoming' as const,
      other: { id: `item-${key}`, projectKey: base.item.item.projectKey, key },
      ...act,
      ended: null,
    });
    const order = { ...base, item: { ...base.item, links: [incoming('3'), incoming('9')] } };
    itemsRead([order.item, partOf(itemDetail('3').item, '1')], { '1': ['3'] });
    const words = text(render(order));
    expect(words).toContain('Members: 0 of 1 merged');
    expect(words).toContain('Has part #9');
    expect(words).not.toContain('Has part #3');
    expect(words).toMatch(/3 [^<]*Waiting Build/);
    // Its own column and state still show: it is worked by the factory.
    expect(words).not.toContain(WORK_ORDER_WORDS);
  });

  test('an order with no run of its own: no column or state, its members', () => {
    const base = itemDetail('1');
    const detail: FactoryItemDetail = {
      ...base,
      runs: [],
      item: {
        ...base.item,
        item: { ...base.item.item, id: 'item-48', key: '48' },
        runs: [],
        questions: [],
        answers: [],
        progress: { ...base.item.progress!, title: null, round: null, change: null, runs: [] },
      },
    };
    itemsRead([partOf(itemDetail('3').item, '48')], { '48': ['3'] });
    const html = render(detail);
    const words = text(html);
    expect(words).toContain(WORK_ORDER_WORDS);
    expect(text(section(html, 'Summary')).trim()).toBe(`#48 Work order #48 ${WORK_ORDER_WORDS}`);
    expect(words).toContain('Members: 0 of 1 merged');
  });

  test('a parked item: the Parked pill, the declared label with its reason on hover', () => {
    const base = itemDetail('1');
    const [triage] = base.item.runs;
    const progress = base.item.progress;
    if (triage === undefined || progress === null) throw new Error('item 1 has runs');
    const why = 'Worth doing, but measure it first.';
    const detail: FactoryItemDetail = {
      ...base,
      runs: base.runs.filter(run => run.runId === triage.id),
      item: {
        ...base.item,
        runs: [{ ...triage, outcome: 'park' }],
        questions: [],
        progress: {
          ...progress,
          running: null,
          round: null,
          change: null,
          runs: progress.runs.filter(run => run.runId === triage.id),
          parked: { label: 'Parked by triage', why },
        },
      },
    };
    const header = section(render(detail), 'Summary');
    expect(header).toContain(pill('parked', 'Parked'));
    expect(text(header)).not.toContain('In Triage');
    expect(text(header)).toContain(`Parked by triage: ${why}`);
  });

  test('a member with no run yet: Not started, no state, column or change', () => {
    const base = itemDetail('1');
    const detail: FactoryItemDetail = {
      ...base,
      runs: [],
      item: {
        ...partOf({ ...base.item, item: { ...base.item.item, id: 'item-58', key: '58' } }, '48'),
        runs: [],
        questions: [],
        answers: [],
        progress: { ...base.item.progress!, title: null, round: null, change: null, runs: [] },
      },
    };
    itemsRead([]);
    const html = render(detail);
    expect(text(section(html, 'Summary')).trim()).toBe('#58 #58 Not started');
    expect(text(html)).toContain('Part of #48');
  });

  test('an order whose members have not started: its members from its own links, N of M merged', () => {
    const base = itemDetail('1');
    const incoming = (key: string) => ({
      id: `link-${key}`,
      kind: 'part_of' as const,
      direction: 'incoming' as const,
      other: { id: `item-${key}`, projectKey: base.item.item.projectKey, key },
      ...act,
      ended: null,
    });
    const detail: FactoryItemDetail = {
      ...base,
      runs: [],
      item: {
        ...base.item,
        item: { ...base.item.item, id: 'item-48', key: '48' },
        runs: [],
        questions: [],
        answers: [],
        progress: { ...base.item.progress!, title: null, round: null, change: null, runs: [] },
        links: [incoming('9'), incoming('10'), { ...incoming('11'), ended: act }],
      },
    };
    // No item on the board names 48, so the items read never asked about it.
    itemsRead([itemDetail('3').item], {});
    const words = text(render(detail));
    expect(words).toContain(WORK_ORDER_WORDS);
    expect(words).toContain('Members: 0 of 2 merged');
    expect(words.match(/Not started/g)).toHaveLength(2);
    // The live links stand as the members; an ended one is no member and stays a raw link.
    expect(words).not.toContain('Has part #9');
    expect(words).toContain('Has part #11 ended');
  });

  test('an untitled member keyed `issue-N` reads #N once, on the board or not started', () => {
    const base = itemDetail('1');
    const incoming = (key: string) => ({
      id: `link-${key}`,
      kind: 'part_of' as const,
      direction: 'incoming' as const,
      other: { id: `item-${key}`, projectKey: base.item.item.projectKey, key },
      ...act,
      ended: null,
    });
    const detail: FactoryItemDetail = {
      ...base,
      runs: [],
      item: {
        ...base.item,
        item: { ...base.item.item, id: 'item-48', key: '48' },
        runs: [],
        questions: [],
        answers: [],
        progress: { ...base.item.progress!, title: null, round: null, change: null, runs: [] },
        links: [incoming('issue-3'), incoming('issue-9')],
      },
    };
    // issue-3 has runs, so it is on the board, untitled; issue-9 has not started.
    const three = partOf(itemDetail('3').item, '48');
    const placed = {
      ...three,
      item: { ...three.item, key: 'issue-3' },
      progress: { ...three.progress!, title: null },
    };
    itemsRead([placed], { '48': ['issue-3', 'issue-9'] });
    const html = render(detail);
    const words = text(html);
    expect(words).toContain('#3');
    expect(words).toContain('#9');
    expect(words).not.toContain('#3 #3');
    expect(words).not.toContain('#9 #9');
    expect(words).not.toContain('issue-');
    expect(html).toContain(`href="/console/p/${PROJECT}/factory/items/issue-3"`);
    expect(html).toContain(`href="/console/p/${PROJECT}/factory/items/issue-9"`);
  });

  test('an order with no run of its own says so from its own links, before the items read', () => {
    const base = itemDetail('1');
    const detail: FactoryItemDetail = {
      ...base,
      runs: [],
      item: {
        ...base.item,
        item: { ...base.item.item, id: 'item-48', key: '48' },
        runs: [],
        progress: { ...base.item.progress!, title: null, round: null, change: null, runs: [] },
        links: [
          {
            id: 'link-3',
            kind: 'part_of',
            direction: 'incoming',
            other: { id: 'item-3', projectKey: base.item.item.projectKey, key: '3' },
            ...act,
            ended: null,
          },
        ],
      },
    };
    const words = text(render(detail));
    expect(words).toContain(WORK_ORDER_WORDS);
    expect(words).not.toContain('In Order');
  });

  test("before the items read, an order's member link reads as the member: #136 · item keys", () => {
    const base = itemDetail('1');
    const detail: FactoryItemDetail = {
      ...base,
      item: {
        ...base.item,
        item: { ...base.item.item, id: 'item-136', key: 'issue-136' },
        links: [
          {
            id: 'link-136',
            kind: 'part_of',
            direction: 'incoming',
            other: {
              id: 'item-m',
              projectKey: base.item.item.projectKey,
              key: 'issue-136-item-keys',
            },
            ...act,
            ended: null,
          },
        ],
      },
    };
    // The link text reads the member; its href keeps the raw key.
    expect(render(detail)).toMatch(
      /href="[^"]*\/factory\/items\/issue-136-item-keys"[^>]*>#136 · item keys<\/a>/
    );
  });

  test('a depends_on link to a split member reads it under its order, as the items read says', () => {
    const member = itemDetail('3').item;
    itemsRead([
      {
        ...member,
        item: { ...member.item, key: 'issue-136-item-keys' },
        progress: { ...member.progress!, partOf: 'issue-136' },
      },
    ]);
    const base = itemDetail('1');
    const detail: FactoryItemDetail = {
      ...base,
      item: {
        ...base.item,
        links: [
          {
            id: 'link-dep',
            kind: 'depends_on',
            direction: 'outgoing',
            other: {
              id: 'item-m',
              projectKey: base.item.item.projectKey,
              key: 'issue-136-item-keys',
            },
            ...act,
            ended: null,
          },
        ],
      },
    };
    expect(render(detail)).toMatch(
      /href="[^"]*\/factory\/items\/issue-136-item-keys"[^>]*>#136 · item keys<\/a>/
    );
  });
});

describe('an issue key on the item page', () => {
  /** Item 111, keyed `key`; untitled when `title` is null. */
  const keyed = (key: string, title?: null): FactoryItemDetail => {
    const base = itemDetail('111');
    const progress = title === null ? { ...base.item.progress!, title } : base.item.progress;
    return { ...base, item: { ...base.item, item: { ...base.item.item, key }, progress } };
  };
  /** The band's mono key, the first thing its title reads. */
  const bandKey = (html: string): string | undefined =>
    /<span class="mr-2 font-mono text-text-tertiary">([^<]*)<\/span>/.exec(
      section(html, 'Summary')
    )?.[1];

  test('`issue-7` and `7` both title the page #7; an untitled one falls back to #7 too', () => {
    for (const key of ['issue-7', '7']) {
      expect(bandKey(render(keyed(key)))).toBe('#7');
      const untitled = render(keyed(key, null));
      expect(bandKey(untitled)).toBe('#7');
      expect(text(section(untitled, 'Summary'))).toContain('#7 #7');
      expect(text(untitled)).not.toContain('issue-7');
    }
  });

  test('a key of neither form titles the page as it is, with no stray #', () => {
    expect(bandKey(render(keyed('abc')))).toBe('abc');
  });

  test("a split member titles the page with its order's number and its piece", () => {
    const act = { at: '2026-11-17T00:00:00.000Z', via: 'cli' as const, by: null, fromRun: null };
    const member = (ended: typeof act | null): FactoryItemDetail => {
      const base = keyed('issue-136-item-keys');
      const link = {
        id: 'link-136',
        kind: 'part_of' as const,
        direction: 'outgoing' as const,
        other: { id: 'item-136', projectKey: base.item.item.projectKey, key: 'issue-136' },
        ...act,
        ended,
      };
      return { ...base, item: { ...base.item, links: [link] } };
    };
    const html = render(member(null));
    expect(bandKey(html)).toBe('#136 · item keys');
    // Membership is the link's, not the key's: with the link ended, the key reads as it is.
    expect(bandKey(render(member(act)))).toBe('issue-136-item-keys');
  });
});
