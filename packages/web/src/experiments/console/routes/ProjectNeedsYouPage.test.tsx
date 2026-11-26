import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { matchesItemFilter, ProjectNeedsYouPage } from './ProjectNeedsYouPage';
import type { ItemAsk } from '../primitives/run';
import type { ItemRead } from '../skills/items';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';

afterEach(() => {
  for (const prefix of ['projects', 'board', 'runs', 'forge-titles']) invalidate(prefix);
});

/** An open ask on `key`, recommending its first option. */
function ask(ref: string, key: string, options: ItemAsk['options'] = OPTIONS): ItemAsk {
  return {
    kind: 'attention',
    ref,
    project: { key: 'acme/web', codebaseId: 'web', name: 'web' },
    item: { id: `id-${key}`, projectKey: 'acme/web', key },
    revision: 1,
    labels: {},
    pausedAt: null,
    message: `Question on ${key}`,
    form: 'select',
    options,
    recommendation: { option: options[0]?.id ?? '', why: 'It fits.' },
  };
}

const OPTIONS: ItemAsk['options'] = [
  { id: 'land', label: 'Land it', does: 'Lands it.', cost: 'Nothing.' },
  { id: 'send-back', label: 'Send it back', does: 'Returns it.', cost: 'A round.' },
];

/** The board's read of `key`: untitled, so its title comes from the forge. */
function read(key: string, partOf: string | null = null): ItemRead {
  return {
    item: { id: `id-${key}`, projectKey: 'acme/web', key, title: null },
    standing: { runId: `run-${key}`, state: 'waiting', pack: null },
    runs: [],
    queued: [],
    skipped: [],
    hold: null,
    held: [],
    runLimit: null,
    startLimits: [],
    waits: [],
    questions: [],
    answers: [],
    links:
      partOf === null
        ? []
        : ([
            {
              kind: 'part_of',
              direction: 'outgoing',
              ended: null,
              other: { id: `id-${partOf}`, projectKey: 'acme/web', key: partOf },
            },
          ] as unknown as ItemRead['links']),
    merged: null,
    landing: null,
    ended: null,
    workOrder: null,
    degraded: [],
  };
}

function seed(asks: ItemAsk[], reads: ItemRead[] = []): void {
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks,
    answerRefusals: {},
    itemIds: new Set<string>(),
    degraded: [],
  });
  set(K.projects, []);
  set(K.boardOrders('web'), reads);
}

function render(path: string): Document {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console/p/:projectId/needs-you" element={<ProjectNeedsYouPage />} />
      </Routes>
    </MemoryRouter>
  );
  const dom = new Window();
  dom.document.body.innerHTML = html;
  return dom.document as unknown as Document;
}

const rowsIn = (doc: Document): string[] =>
  [...doc.querySelectorAll('[data-needs-row]')].map(row => row.getAttribute('data-item-key') ?? '');

const TWO_ITEMS = [ask('ask:a', 'issue-198'), ask('ask:b', 'issue-198'), ask('ask:c', 'issue-200')];

test('a filter shows only that item, with a chip that links back to every item', () => {
  seed(TWO_ITEMS);
  const doc = render('/console/p/web/needs-you?item=198');
  expect(rowsIn(doc)).toEqual(['issue-198']);
  const chip = doc.querySelector('[data-item-filter="198"]');
  expect(chip?.getAttribute('href')).toBe('/console/p/web/needs-you');
  expect(chip?.textContent).toContain('#198');
  expect(doc.querySelector('[role="status"]')?.textContent).toBe('2 open asks');
});

test('with the filter cleared every item shows, and no chip', () => {
  seed(TWO_ITEMS);
  const doc = render('/console/p/web/needs-you');
  expect(rowsIn(doc).sort()).toEqual(['issue-198', 'issue-200']);
  expect(doc.querySelector('[data-item-filter]')).toBeNull();
});

test('the filter takes comma-separated and repeated values; each chip drops only its own', () => {
  seed(TWO_ITEMS);
  for (const path of [
    '/console/p/web/needs-you?item=198,200',
    '/console/p/web/needs-you?item=198&item=200',
  ]) {
    const doc = render(path);
    expect(rowsIn(doc).sort()).toEqual(['issue-198', 'issue-200']);
    expect(doc.querySelector('[data-item-filter="198"]')?.getAttribute('href')).toBe(
      '/console/p/web/needs-you?item=200'
    );
  }
});

test('a filtered item with one ask opens that ask; unfiltered it stays closed', () => {
  seed(TWO_ITEMS);
  const filtered = render('/console/p/web/needs-you?item=issue-200');
  expect(filtered.querySelector('[data-ask-ref="ask:c"]')).not.toBeNull();
  const unfiltered = render('/console/p/web/needs-you');
  expect(unfiltered.querySelector('[data-ask-ref]')).toBeNull();
  // An item with two asks shows its row closed even when filtered.
  const two = render('/console/p/web/needs-you?item=198');
  expect(two.querySelector('[data-ask-ref]')).toBeNull();
});

test('rows carry the issue title and the key as the board prints it', () => {
  seed(
    [ask('ask:a', 'issue-198'), ask('ask:m', 'issue-199-board-card')],
    [read('issue-198'), read('issue-199-board-card', 'issue-199')]
  );
  set(K.forgeTitles('web', [198]), {
    issues: [{ number: 198, title: 'Asks show in full', state: 'open', url: null, pending: false }],
    changes: [],
  });
  const doc = render('/console/p/web/needs-you');
  const row = (key: string): Element | null => doc.querySelector(`[data-item-key="${key}"]`);
  expect(row('issue-198')?.textContent).toContain('#198');
  expect(row('issue-198')?.querySelector('[data-item-title]')?.textContent).toBe(
    'Asks show in full'
  );
  expect(row('issue-199-board-card')?.textContent).toContain('#199 · board card');
});

test('the recommendation reads as a muted suggestion by its label, never green', () => {
  seed([
    ask('ask:a', 'issue-198'),
    ask('ask:c', 'issue-200', [{ id: 'send-back', does: 'Returns it.', cost: 'A round.' }]),
  ]);
  const doc = render('/console/p/web/needs-you');
  expect(doc.querySelector('[data-item-key="issue-198"] [data-suggested]')?.textContent).toBe(
    'Suggested: Land it'
  );
  expect(doc.querySelector('[data-item-key="issue-200"] [data-suggested]')?.textContent).toBe(
    'Suggested: Send back'
  );
  for (const line of doc.querySelectorAll('[data-suggested]')) {
    expect(line.className).not.toContain('success');
  }
});

test('a filter that matches nothing keeps its chip and says so', () => {
  seed(TWO_ITEMS);
  const doc = render('/console/p/web/needs-you?item=999');
  expect(rowsIn(doc)).toEqual([]);
  expect(doc.querySelector('[data-item-filter="999"]')?.getAttribute('href')).toBe(
    '/console/p/web/needs-you'
  );
  expect(doc.body.textContent).toContain('Nothing needs you on #999.');
});

describe('matchesItemFilter', () => {
  const of = (key: string): Pick<ItemAsk, 'item'> => ({
    item: { id: `id-${key}`, projectKey: 'acme/web', key },
  });
  test('an issue number and its raw key name one item', () => {
    expect(matchesItemFilter(of('issue-198'), '198')).toBe(true);
    expect(matchesItemFilter(of('198'), 'issue-198')).toBe(true);
    expect(matchesItemFilter(of('issue-198'), 'issue-198')).toBe(true);
    expect(matchesItemFilter(of('issue-198'), '19')).toBe(false);
  });
  test('a member is named by its own key, not its parent number', () => {
    expect(matchesItemFilter(of('issue-199-board-card'), '199')).toBe(false);
    expect(matchesItemFilter(of('issue-199-board-card'), 'issue-199-board-card')).toBe(true);
  });
  test('an ask with no item matches no filter', () => {
    expect(matchesItemFilter({}, '198')).toBe(false);
  });
});
