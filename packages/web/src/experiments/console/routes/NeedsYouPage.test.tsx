import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { NeedsYouPage } from './NeedsYouPage';
import type { ItemAsk } from '../primitives/run';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';

afterEach(() => {
  invalidate('runs');
});

const ask = (ref: string, project: string): ItemAsk => ({
  kind: 'attention',
  ref,
  project: { key: `acme/${project}`, codebaseId: project, name: project },
  item: { id: `item-${ref}`, projectKey: `acme/${project}`, key: 'issue-1' },
  revision: 1,
  labels: {},
  pausedAt: null,
  message: `Question in ${project}`,
  form: 'select',
  options: [{ id: 'go', does: 'Goes on.', cost: 'Nothing.' }],
});

test('asks from every project are on the one page, each answerable by its ref', () => {
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [ask('ask:a1', 'web'), ask('ask:b1', 'docs')],
    answerRefusals: {},
    itemIds: new Set<string>(),
    degraded: [],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NeedsYouPage />
    </MemoryRouter>
  );
  expect(html).toContain('data-ask-ref="ask:a1"');
  expect(html).toContain('data-ask-ref="ask:b1"');
});
