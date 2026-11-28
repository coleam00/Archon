import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { toRun } from '../primitives/run';
import { detailFixture } from '../primitives/run.test-fixtures';
import { RecentRunRow } from './RecentRunRow';

const KEY = 'crusader/crusader-engine#138';

function render(itemKey: string | null): string {
  const run = toRun({ ...detailFixture.run, item_key: itemKey });
  return renderToStaticMarkup(
    <MemoryRouter>
      <RecentRunRow run={run} />
    </MemoryRouter>
  );
}

test('a run on an item names it on the row', () => {
  const row = render(KEY);
  expect(row).toContain(KEY);
  expect(row).toContain(`title="On item ${KEY}"`);
});

test('a run on no item leaves the row without one', () => {
  const row = render(null);
  // The workflow name is still there, so the absence is the item's, not the row's.
  expect(row).toContain(detailFixture.run.workflow_name);
  expect(row).not.toContain('On item');
});

test('an item key is shown whole, however long it runs', () => {
  const long = `owner/${'r'.repeat(120)}#1`;
  const row = render(long);
  expect(row).toContain(long);
  // Whole and wrapping: the row shrinks the key rather than cutting it off, so a long key
  // costs the row a line instead of the operator half an identifier.
  const key = row.slice(row.indexOf(`title="On item ${long}"`) - 200, row.indexOf(`>${long}<`));
  expect(key).toContain('break-words');
  expect(key).not.toContain('truncate');
});
