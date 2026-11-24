import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { FactoryItem } from '../../skills/factory';
import { progressOf, realItem, VIEW } from '../lib/board.test-fixtures';
import { ItemsHere } from './StageItems';

/** Item 7 of the fixture page, keyed `key`, with no title of its own. */
const untitled = (key: string): FactoryItem => {
  const item = realItem('7');
  return {
    ...item,
    item: { ...item.item, key },
    progress: { ...progressOf(item), title: null },
  };
};

test('an untitled row reads `issue-7` and `7` as #7, its link keeping the key', () => {
  const stage = VIEW.stages[0];
  if (stage === undefined) throw new Error('the view declares no stage');
  for (const key of ['issue-7', '7']) {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ItemsHere
          projectId="cb-1"
          view={VIEW}
          stage={stage}
          live={{ items: [untitled(key)], working: 0, needYou: [], pending: false }}
          empty="Nothing here"
          resting
        />
      </MemoryRouter>
    );
    const words = html.replace(/<[^>]*>/g, ' ');
    expect(words).toContain('#7');
    expect(words).not.toContain('issue-7');
    expect(words).not.toMatch(/#7\s+7\b/);
    expect(html).toContain(`href="/console/p/cb-1/factory/items/${key}"`);
  }
});
