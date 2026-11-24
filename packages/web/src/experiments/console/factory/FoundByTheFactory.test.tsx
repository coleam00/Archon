import { afterEach, expect, test } from 'bun:test';
import { MemoryRouter } from 'react-router';
import { installDom } from '../test-dom.test-helpers';
import { invalidate, set } from '../store/cache';
import { formatDateTime } from '../lib/format';
import { K } from '../store/keys';
import { FoundByTheFactory, FoundByTheFactoryLine } from './FoundByTheFactory';
import { DISCOVERIES } from './lib/discoveries.test-fixtures';
import type { ItemName } from '../lib/ask-naming';

// A failed read follows a render, which static markup cannot reach.
const { mount: render } = await installDom();

const ID = 'cb-found';
afterEach(() => {
  invalidate('factory-items');
});

/** The line and the opened panel, as the board draws them with its strips open. */
async function mount(names: ReadonlyMap<string, ItemName> = new Map()) {
  const { container, unmount } = await render(
    <MemoryRouter initialEntries={[`/console/p/${ID}/factory/board`]}>
      <div data-line>
        <FoundByTheFactoryLine projectId={ID} />
      </div>
      <div data-body>
        <FoundByTheFactory projectId={ID} names={names} />
      </div>
    </MemoryRouter>
  );
  const line = container.querySelector('[data-line]')!;
  const body = container.querySelector('[data-body]')!;
  return { container, line, body, unmount };
}

test('the line: its name, the shadow badge and the count', async () => {
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  const { line, unmount } = await mount();
  try {
    expect(line.querySelector('h2')?.textContent).toBe('Found by the factory');
    expect(line.textContent).toContain('shadow');
    expect(line.querySelector('[data-found-count]')?.textContent).toBe('2');
    expect(line.textContent).toContain('the factory would file');
    // One line: no chips, no shadow sentence, no list.
    expect(line.querySelector('ul')).toBeNull();
    expect(line.textContent).not.toContain('files nothing yet');
  } finally {
    await unmount();
  }
});

test('opened: the count no item covers, the chips, the shadow line and the findings listed', async () => {
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  const { body, unmount } = await mount();
  try {
    // The heading is the line's, once on the page.
    expect(body.querySelector('h2')).toBeNull();
    expect(body.textContent).toContain('files nothing yet');
    expect(body.querySelector('[data-found-count]')?.textContent).toBe('2');
    const chips = [...body.querySelectorAll('[aria-label="What the drains decided"] li')];
    expect(chips.map(li => li.textContent)).toEqual(['would file 3', 'held 10', 'dropped 16']);
    // One finding an item covers, and one drain that could not be read.
    expect(body.textContent).toMatch(/1 already on the board/);
    expect(body.textContent).toMatch(/1 drain could not be read/);
    // Listed at once: the board's toggle opened it, and nothing inside it toggles again.
    expect(body.querySelector('button')).toBeNull();
    const rows = [...body.querySelectorAll('#found-by-the-factory-list > li')];
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first?.textContent).toContain('Defect');
    expect(first?.textContent).toContain('A dev:console server on a seeded copy');
    expect(first?.textContent).toContain('#58 · Items window read takes ~1.1 s');
    // When that drain decided, as the board's cards word a time.
    expect(first?.textContent).toContain(formatDateTime(DISCOVERIES.findings[0]!.decidedAt));
    expect(first?.querySelector('a')?.getAttribute('href')).toBe(
      '/console/p/cb-found/factory/items/58'
    );
    // The verified line is on hover, and read out to a screen reader.
    expect(first?.getAttribute('title')).toBe(DISCOVERIES.findings[0]?.verified ?? '');
    expect(first?.textContent).toContain('Verified:');
    expect(second?.textContent).toContain('Cleanup');
    expect(second?.hasAttribute('title')).toBe(false);
    // The covered finding is not listed.
    expect(body.textContent).not.toContain('CI runs the packages');
  } finally {
    await unmount();
  }
});

test.each([
  [
    'not a shadow: no badge, its filed count',
    { shadow: false },
    'filed, not on the board yet',
    'filed 3',
  ],
  [
    'nothing open: an empty state, not a zero list',
    { findings: [], unreadable: 0 },
    'Nothing the factory would file now',
    'Nothing the factory would file now.',
  ],
] as const)('%s', async (_name, change, onLine, inBody) => {
  set(K.factoryDiscoveries(ID), { ...DISCOVERIES, ...change });
  const { container, line, body, unmount } = await mount();
  try {
    expect(line.textContent).toContain(onLine);
    expect(body.textContent).toContain(inBody);
    if ('shadow' in change) expect(container.textContent).not.toContain('shadow');
    else expect(body.querySelector('#found-by-the-factory-list')).toBeNull();
  } finally {
    await unmount();
  }
});
