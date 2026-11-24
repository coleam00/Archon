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
import { askItem } from '../lib/needs-you.test-fixtures';
import { WORK_ORDER_WORDS } from './ItemWorkOrder';
import { formatDateTime } from '../lib/format';

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

const listing: FactoryViews = { views: [shippedListed], errors: [] };
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

/** The markup of each cell of a grid row. */
const row = (html: string, name: string): string[] =>
  [
    ...(new RegExp(`data-grid-row="${name}"([^]*?)</tr>`).exec(html)?.[1] ?? '').matchAll(
      /<td([^>]*>[\s\S]*?)<\/td>/g
    ),
  ].map(m => m[1] ?? '');

type Item = FactoryItemDetail['item'];
const act = { at: '2026-11-17T00:00:00.000Z', via: 'cli' as const, by: null, fromRun: null };
/** A `kind` link from or to item `key`, ended when `ended` is given. */
const link = (
  key: string,
  kind: 'depends_on' | 'part_of',
  direction: 'incoming' | 'outgoing',
  ended: typeof act | null = null
): Item['links'][number] => ({
  id: `link-${key}`,
  kind,
  direction,
  other: { id: `item-${key}`, projectKey: 'p', key },
  ...act,
  ended,
});

describe('the item page', () => {
  test('item 111, merged: band, journey, one panel per stage, the checks grid and its links', () => {
    const detail = itemDetail('111');
    const links = [link('4', 'depends_on', 'outgoing'), link('9', 'part_of', 'incoming', act)];
    const html = render({ ...detail, item: { ...detail.item, links } });
    const band = text(section(html, 'Summary'));
    for (const words of ['Merged', '#111', 'PR #112', 'Its change merged.']) {
      expect(band).toContain(words);
    }
    // Merged says so once: the pill, then the PR with a quiet "merged", no "In Merged".
    expect(band).not.toContain('In Merged');
    expect(html).toMatch(/data-merge-state="true"[^>]*>merged</);
    expect(chips(html)).toEqual([
      '1 h 6 min order to merge',
      '$21.94 cost',
      '2 of 3 check rounds',
      '0 asks answered',
    ]);
    const strip = section(html, 'Journey');
    expect(
      [...strip.matchAll(/data-journey-segment="([a-z-]+)"(.*?)<\/li>/g)].map(m => [
        m[1],
        text(`<${m[2] ?? ''}`).trim(),
      ])
    ).toEqual([
      ['intake', 'Intake 1 min'],
      ['plan-build', 'Plan & build 39 min'],
      ['checks-review', 'Checks & review 22 min sent back 1x to Plan & build'],
      ['ready', 'Ready to merge 3 min'],
      ['merged', 'Merged Merged It is here now'],
    ]);
    expect(strip).toMatch(/data-journey-segment="merged" data-lit=""/);
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
    // The deliver run's one cost, on each panel it worked, said to be the whole run's.
    expect(text(panel(html, 'build'))).toContain(
      'Cost $18.14 for the whole run, across its stages'
    );
    expect(text(html)).toContain(
      'Sent back : a check found something to fix and returned the change to the builder. Approved : the check passed.'
    );
    // Each cell is an icon and a word, never a colour alone.
    expect(row(html, 'Code review').map(cell => text(`<${cell}`).trim())).toEqual([
      'Sent back',
      'Approved',
    ]);
    expect(row(html, 'Build').map(cell => text(`<${cell}`).trim())).toEqual(['Fixed', 'Not run']);
    expect(text(html)).toContain('Depends on #4');
    expect(text(html)).toContain('Has part #9 ended');
    expect(html).toContain(`href="/console/p/${PROJECT}/factory/items/4"`);
  });

  test('the merge state reads as quiet words: unknown, open, or checking while it is read', () => {
    const detail = itemDetail('3');
    const change = detail.item.progress?.change;
    if (change === undefined || change === null) throw new Error('item 3 has a change');
    const withMerged = (merged: typeof change.merged): FactoryItemDetail => ({
      ...detail,
      item: {
        ...detail.item,
        progress: { ...detail.item.progress!, change: { ...change, merged } },
      },
    });
    expect(render(withMerged(false))).toMatch(/data-merge-state="false"[^>]*>open</);
    expect(text(render(withMerged('pending')))).toContain('checking whether it merged');
  });

  test('item 125, three stages: four rounds, sent back and waited on you, then CI', () => {
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
    expect(text(strip)).toMatch(/waited on you \d+ min/);
    const ci = text(panel(html, 'host'));
    expect(ci).toContain('CI and the reviews passed.');
    expect(ci).toContain('Build fixed what CI and the reviews raised');
  });

  test('item 113: the answered ask in its Build panel, what you chose, who, and what it started', () => {
    const html = render(itemDetail('113'));
    const build = panel(html, 'build');
    expect(text(build)).toContain('You said Send back');
    expect(text(build)).toContain('by cole-owner');
    expect(build).toContain('data-started="Build started again"');
    expect(chips(html)).toContain('1 ask answered');
  });

  test('item 86: parked, then asked for shaping, with the questions to settle', () => {
    const parked = render(itemDetail('86'));
    expect(text(section(parked, 'Summary'))).toContain('Parked');
    expect(text(section(parked, 'Journey'))).toContain('Stopped here: Parked by triage');
    expect(text(section(parked, 'Journey')).match(/Not reached/g)).toHaveLength(4);

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
    expect(text(section(html, 'Summary'))).toContain(
      'Needs shaping: Worth doing once the scope is settled.'
    );
    expect(text(section(html, 'Journey'))).toContain('Stopped here: Needs shaping');
    const awaits = text(/data-awaits=""[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '');
    for (const words of [
      'Questions to settle',
      'Which surfaces does it touch?',
      'Is it one change or two?',
      `What to do ${shippedView.awaits?.['triage:shape']?.next ?? '?'}`,
    ]) {
      expect(awaits).toContain(words);
    }
    expect(sentences(html)).toContainEqual([
      'triage',
      'Triage judged it worth doing, once a maintainer settles its open questions.',
    ]);
  });

  test('item 6 runs; with asks open it needs you, listing only its own asks, answerable', () => {
    const running = render(itemDetail('6'));
    expect(text(section(running, 'Summary'))).toContain('Running');
    expect(sentences(running)).toContainEqual([
      'build',
      'Build is working on it now: Writes the change.',
    ]);
    expect(text(running)).toContain('No change yet');

    const detail = itemDetail('6');
    const mine = askItem({ ref: 'ask:mine', item: { ...detail.item.item } });
    // A wait in a child run names no item; the item read lists it among its questions.
    const child = askItem({ ref: 'ask:child', item: undefined, message: 'From the child run?' });
    const other = askItem({ ref: 'ask:other', message: 'Not this item?' });
    const read = { ...detail, item: { ...detail.item, questions: [child] } };
    const html = render(read, { items: [mine, child, other], runs: [], degraded: [] });
    const band = text(section(html, 'Summary'));
    expect(band).toContain('Needs you');
    expect(band).not.toContain('Running');
    expect(text(html)).toContain('Which base should the change target?');
    expect(text(html)).toContain('From the child run?');
    expect(text(html)).not.toContain('Not this item?');
    // Each as the ask card, always open: its tiles, the recommended one first, answerable.
    expect(html.split('data-ask=')).toHaveLength(3);
    expect(text(html)).toContain('Use dev Recommended Rebases onto dev.');
  });

  test('while the item is read: skeletons, never Loading…', () => {
    set(K.factoryViews(PROJECT), listing);
    set(K.projectAttention(PROJECT), quiet);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/console/p/${PROJECT}/factory/items/77`]}>
        <Routes>{projectRoutes('/console/')}</Routes>
      </MemoryRouter>
    );
    expect(text(html)).toContain('Loading the item');
    expect(html).toContain('data-skeleton="block"');
    expect(html).not.toContain('Loading…');
  });
});

describe('work orders on the item page', () => {
  test('order #48 with no run of its own: its members from its links, N of M merged', () => {
    const three = itemDetail('3').item;
    const placed = {
      ...three,
      item: { ...three.item, key: 'issue-3' },
      progress: { ...three.progress!, title: null, partOf: '48' },
    };
    set(K.factoryItems(PROJECT), { items: [placed], members: { '48': ['issue-3', '10'] } });
    const base = itemDetail('1');
    const html = render({
      ...base,
      runs: [],
      item: {
        ...base.item,
        item: { ...base.item.item, id: 'item-48', key: '48' },
        runs: [],
        questions: [],
        answers: [],
        progress: { ...base.item.progress!, title: null, round: null, change: null, runs: [] },
        links: [
          link('issue-3', 'part_of', 'incoming'),
          link('10', 'part_of', 'incoming'),
          link('11', 'part_of', 'incoming', act),
        ],
      },
    });
    const words = text(html);
    expect(text(section(html, 'Summary')).trim()).toBe(`#48 Work order #48 ${WORK_ORDER_WORDS}`);
    expect(words).toContain('Members: 0 of 2 merged');
    expect(words).toContain('#3');
    expect(words).not.toContain('issue-');
    expect(words.match(/Not started/g)).toHaveLength(1);
    // The live links stand as the members; an ended one is no member and stays a raw link.
    expect(words).not.toContain('Has part #10');
    expect(words).toContain('Has part #11 ended');
    expect(html).toContain(`href="/console/p/${PROJECT}/factory/items/issue-3"`);
  });

  test('a member its order run placed, with no link: Part of the order it named', () => {
    const detail = itemDetail('3');
    const item = { ...detail.item, progress: { ...detail.item.progress!, partOf: '48' } };
    set(K.factoryItems(PROJECT), { items: [item], members: {} });
    const html = render({ ...detail, item });
    expect(text(html)).toContain('Part of #48 as its order run recorded');
    expect(html).toContain(`href="/console/p/${PROJECT}/factory/items/48"`);
  });
});
