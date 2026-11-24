import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { LONG } from '../components/ask-card/wrap.test-fixtures';
import { installDom } from '../test-dom.test-helpers';
import { askItem } from '../lib/needs-you.test-fixtures';
import type { FactoryItem } from '../skills/factory';
import type { AttentionQueue, AttentionQueueItem } from '../skills/runs';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { ProjectAttentionProvider } from '../components/ProjectAttention';
import { Board } from './BoardPage';
import { realItem, VIEW } from './lib/board.test-fixtures';
import { DISCOVERIES } from './lib/discoveries.test-fixtures';
import { itemWith, run, settledItem } from './lib/map.test-fixtures';
import { cancelRereads } from './merge-reread';
import { cancelMergeWatches } from './merge-watch';

// The popover opens, closes and moves focus on events, which static markup cannot reach.
const { dom, mount: render } = await installDom();
const originalFetch = globalThis.fetch;
/** Every read comes from the cache the test sets; only an answer is sent, where a test serves it. */
function serveAnswers(): string[] {
  const sent: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      // The queue comes from the cache; a cold one stays unread.
      if (path.includes('/api/runs/attention')) return new Promise<Response>(() => undefined);
      if (path !== '/api/attention/answer') throw new Error(`the board test fetched ${path}`);
      sent.push(path);
      return Response.json({ success: true });
    },
    { preconnect: originalFetch.preconnect }
  );
  return sent;
}
serveAnswers();

const ID = 'cb-1';
const NOW = new Date(2026, 10, 18, 12, 0);
// Both share project cb-1: a reread or merge watch left running would land in the next test.
afterEach(() => {
  cancelRereads();
  cancelMergeWatches();
  invalidate('factory-items');
});

/** An ask on `item`, as the queue and the item read both list it. */
function askOn(item: FactoryItem, overrides: Parameters<typeof askItem>[0] = {}) {
  return askItem({
    item: { id: item.item.id, projectKey: 'acme', key: item.item.key },
    ...overrides,
  });
}

/** `item` with `asks` open on it: the item read lists them, so its pill is Needs you. */
function asking(item: FactoryItem, asks: AttentionQueueItem[]): FactoryItem {
  return { ...item, questions: asks };
}

const queueOf = (items: AttentionQueueItem[]): AttentionQueue => ({
  items,
  runs: [],
  degraded: [],
});

/** The board with `queue` as the project's attention queue; `null` for one not read yet. */
async function mount(items: FactoryItem[], queue: AttentionQueue | null, path = '') {
  set(K.factoryItems(ID), { items, members: {} });
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  if (queue === null) invalidate('runs');
  else set(K.projectAttention(ID), queue);
  return render(
    <MemoryRouter initialEntries={[`/console/p/${ID}/factory/board${path}`]}>
      <Routes>
        <Route
          path="/console/p/:projectId/factory/board"
          element={
            <ProjectAttentionProvider projectId={ID}>
              <Board projectId={ID} view={VIEW} now={NOW} />
            </ProjectAttentionProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const card = (container: HTMLElement, key: string): HTMLElement =>
  container.querySelector<HTMLElement>(`article[data-card="${key}"]`)!;
const face = (container: HTMLElement, key: string): HTMLButtonElement =>
  card(container, key).querySelector<HTMLButtonElement>('button[data-ask-trigger]')!;
const dialog = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[role="dialog"]');

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A button in the open dialog whose text starts with `label`. */
function dialogButton(label: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(candidate =>
    candidate.textContent?.startsWith(label)
  );
  if (found === undefined) throw new Error(`No button "${label}" in the dialog`);
  return found;
}

describe("a board card's ask", () => {
  test('one ask: its question, "Recommended", the ping; several: the newest and "N questions"', async () => {
    const six = realItem('6');
    const three = realItem('3');
    const one = askOn(six);
    const several = [
      askOn(three, { ref: 'ask:1', pausedAt: '2026-11-16T09:00:00.000Z', message: 'Oldest?' }),
      askOn(three, { ref: 'ask:2', pausedAt: '2026-11-16T10:00:00.000Z', message: 'Middle?' }),
      askOn(three, { ref: 'ask:3', pausedAt: '2026-11-16T11:00:00.000Z', message: LONG }),
    ];
    const single = await mount([asking(six, [one])], queueOf([one]));
    try {
      const { container } = single;
      const button = face(container, '6');
      expect(button.textContent).toContain('Which base should the change target?');
      expect(button.textContent).toContain('Recommended: Use dev');
      expect(button.textContent).not.toContain('questions');
      expect(button.querySelector('[data-ping]')).not.toBeNull();
      expect(button.getAttribute('aria-label')).toBe(
        'Answer: Which base should the change target?'
      );
      // The question shows once: on the face, not again as the stop line.
      const words = card(container, '6').textContent ?? '';
      expect(words.split('Which base should the change target?').length).toBe(2);
    } finally {
      await single.unmount();
    }
    const { container, unmount } = await mount([asking(three, several)], queueOf(several));
    try {
      // The newest question on the face, cut to its line and whole on hover, with the count.
      const newest = face(container, '3');
      expect(newest.textContent).toContain(`${LONG}3 questions`);
      expect(newest.querySelector(`[title="${LONG}"]`)).not.toBeNull();
      expect(newest.textContent).not.toContain('Oldest?');
    } finally {
      await unmount();
    }
  });

  test('no face while the queue is unread, or for an ask the queue does not list', async () => {
    const item = realItem('6');
    const ask = askOn(item);
    for (const queue of [null, queueOf([])]) {
      const { container, unmount } = await mount([asking(item, [ask])], queue);
      try {
        expect(card(container, '6').querySelector('button[data-ask-trigger]')).toBeNull();
        // The question stays on the card as its stop line.
        expect(card(container, '6').textContent).toContain('Which base should the change target?');
      } finally {
        await unmount();
      }
    }
  });
});

describe('the ask popover', () => {
  const six = realItem('6');
  const three = realItem('3');
  const sixAsk = askOn(six, { ref: 'ask:six' });
  const threeAsk = askOn(three, {
    ref: 'ask:three',
    message: 'Split the item?',
    options: [{ id: 'split', label: 'Split it' }],
    recommendation: undefined,
  });
  const items = [asking(six, [sixAsk]), asking(three, [threeAsk])];
  const queue = queueOf([sixAsk, threeAsk]);

  test("opens with that item's asks only; Esc or a press outside closes it, focus returning", async () => {
    const { container, unmount } = await mount(items, queue);
    try {
      expect(dialog()).toBeNull();
      await click(face(container, '6'));
      const open = dialog();
      expect(open?.getAttribute('aria-label')).toBe('Asks on #6');
      // Portalled to the body, out of the card's clipped box.
      expect(container.contains(open)).toBe(false);
      expect(open?.textContent).toContain('Which base should the change target?');
      expect(open?.textContent).toContain('Use dev');
      expect(open?.textContent).not.toContain('Split the item?');
      expect(open?.querySelector('[data-preview-slot]')?.childElementCount).toBe(0);
      expect(face(container, '6').getAttribute('aria-expanded')).toBe('true');
      // Focus moves into it, to the ask card.
      expect(document.activeElement?.getAttribute('data-ask')).toBe('ask:six');
      const press = (target: EventTarget): Promise<void> =>
        act(async () => {
          target.dispatchEvent(
            new dom.MouseEvent('mousedown', { bubbles: true }) as unknown as Event
          );
        });
      await press(dialogButton('Use main'));
      expect(dialog()).not.toBeNull();
      await press(container);
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(face(container, '6'));

      const trigger = face(container, '3');
      await click(trigger);
      expect(dialog()?.getAttribute('aria-label')).toBe('Asks on #3');
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event
        );
      });
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      await unmount();
    }
  });

  test("the Table's Answer button opens the same popover", async () => {
    const { container, unmount } = await mount(items, queue, '?view=table');
    try {
      const answer = container.querySelector<HTMLButtonElement>(
        'tr[data-card="3"] button[data-ask-trigger]'
      );
      expect(answer?.textContent).toBe('Answer');
      await click(answer!);
      expect(dialog()?.getAttribute('aria-label')).toBe('Asks on #3');
      expect(dialog()?.textContent).toContain('Split the item?');
    } finally {
      await unmount();
    }
  });
});

describe('answering from the board', () => {
  // The item asked in plan and waits; settling its asks starts plan again.
  const waiting = itemWith('6', [run('plan', 'completed', 'ask')]);
  const asked = waiting.runs[0]?.id ?? '';
  const ask = askOn(waiting, { ref: 'ask:last', askedIn: { runId: asked, workflow: 'plan' } });

  // The Pipeline card and the Table row each draw the answered line (RowAsk in the Table).
  test.each(['', '?view=table'])(
    'the last ask: the popover closes, the item says what was answered, then what started again (%s)',
    async view => {
      const sent = serveAnswers();
      const { container, unmount } = await mount([asking(waiting, [ask])], queueOf([ask]), view);
      const held = (): HTMLElement => container.querySelector<HTMLElement>('[data-card="6"]')!;
      try {
        await click(held().querySelector<HTMLButtonElement>('button[data-ask-trigger]')!);
        await click(dialogButton('Use dev'));
        await click(dialogButton('Confirm'));
        expect(sent).toEqual(['/api/attention/answer']);
        expect(dialog()).toBeNull();
        expect(held().textContent).toContain('Answered: Use dev');
        expect(held().querySelector('button[data-ask-trigger]')).toBeNull();

        // The next items read records the settled set and the plan run it started.
        const settled = settledItem(
          '6',
          run('plan', 'completed', 'ask'),
          '2026-11-18T11:00:00.000Z',
          run('plan', 'running', null, 'plan')
        );
        await act(async () => set(K.factoryItems(ID), { items: [settled], members: {} }));
        expect(held().textContent).toContain('Answered · Plan started again');

        // The restarted run fails in the same stage: the card says so, not what was answered.
        const failed = settledItem(
          '6',
          run('plan', 'completed', 'ask'),
          '2026-11-18T11:00:00.000Z',
          run('plan', 'failed', null, 'plan')
        );
        await act(async () => set(K.factoryItems(ID), { items: [failed], members: {} }));
        expect(held().textContent).toContain('Failed');
        expect(held().textContent).not.toContain('Answered');

        // A read that moves the card ends it.
        const moved = itemWith('6', [
          run('plan', 'completed', 'ask'),
          run('deliver', 'running', null, 'implement'),
        ]);
        await act(async () => set(K.factoryItems(ID), { items: [moved], members: {} }));
        expect(held().textContent).not.toContain('Answered');
      } finally {
        serveAnswers();
        await unmount();
      }
    }
  );

  test('one of several: the popover stays open with the rest, and the card is not held', async () => {
    serveAnswers();
    const other = askOn(waiting, {
      ref: 'ask:other',
      pausedAt: '2026-11-16T08:00:00.000Z',
      message: 'Split the item?',
      options: [{ id: 'split', label: 'Split it' }],
      recommendation: undefined,
    });
    const { container, unmount } = await mount(
      [asking(waiting, [ask, other])],
      queueOf([ask, other])
    );
    try {
      await click(face(container, '6'));
      await click(dialogButton('Use dev'));
      await click(dialogButton('Confirm'));
      expect(dialog()?.textContent).toContain('Answered: Use dev');
      expect(dialog()?.textContent).toContain('Split the item?');
      expect(card(container, '6').textContent).not.toContain('Answered');
    } finally {
      serveAnswers();
      await unmount();
    }
  });
});
