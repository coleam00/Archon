import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { holding, LONG, wrapsAnywhere } from '../components/ask-card/wrap.test-fixtures';
import { askItem, gateItem } from '../lib/needs-you.test-fixtures';
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
const dom = new Window({ url: 'http://localhost' });
/** The project's attention stream, which says nothing here. */
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}
const globals = {
  window: dom,
  document: dom.document,
  EventSource: QuietEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
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

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const ID = 'cb-1';
const NOW = new Date(2026, 10, 18, 12, 0);
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
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  if (queue === null) invalidate('runs');
  else set(K.projectAttention(ID), queue);
  const board = (): ReactElement => (
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
  await act(async () => root.render(board()));
  return {
    container,
    unmount: async (): Promise<void> => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const card = (container: HTMLElement, key: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`article[data-card="${key}"]`);
  if (found === null) throw new Error(`No card ${key}`);
  return found;
};
const face = (container: HTMLElement, key: string): HTMLButtonElement => {
  const found = card(container, key).querySelector<HTMLButtonElement>('button[data-ask-trigger]');
  if (found === null) throw new Error(`No ask face on ${key}`);
  return found;
};
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
  test('one ask: its question, "Recommended: <label>" and the ping, in place of the stop line', async () => {
    const item = realItem('6');
    const ask = askOn(item);
    const { container, unmount } = await mount([asking(item, [ask])], queueOf([ask]));
    try {
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
      await unmount();
    }
  });

  test('an asking card is short: title 2 lines, the question one line with the ping and count', async () => {
    // The board's columns fit two cards at 1440x900 only if an asking card stays short; the
    // popover holds the whole question (owner decision of 2026-11-19 on #91).
    const item = realItem('6');
    const asks = [
      askOn(item, { ref: 'ask:1', pausedAt: '2026-11-16T09:00:00.000Z', message: 'Older?' }),
      askOn(item, { ref: 'ask:2', pausedAt: '2026-11-16T10:00:00.000Z', message: 'Newer?' }),
    ];
    const { container, unmount } = await mount([asking(item, asks), realItem('7')], queueOf(asks));
    try {
      const title = (key: string) =>
        [...card(container, key).querySelectorAll('a')].find(link =>
          link.className.includes('after:absolute')
        );
      expect(title('6')?.classList.contains('line-clamp-2')).toBe(true);
      // A card with no ask keeps its 3 lines.
      expect(title('7')?.classList.contains('line-clamp-3')).toBe(true);
      const button = face(container, '6');
      const line = button.querySelector('[data-ping]')?.parentElement;
      const question = [...(line?.children ?? [])].find(child => child.textContent === 'Newer?');
      expect(question?.classList.contains('truncate')).toBe(true);
      expect(question?.getAttribute('title')).toBe('Newer?');
      expect(line?.textContent).toBe('Newer?2 questions');
    } finally {
      await unmount();
    }
  });

  test('a long unbroken question and option label stay inside the card; the line is green', async () => {
    const item = realItem('6');
    const question = `question:${LONG}`;
    const label = `label:${LONG}`;
    const ask = askOn(item, {
      message: question,
      options: [{ id: 'long', label }],
      recommendation: { option: 'long', why: 'Why.' },
    });
    const { container, unmount } = await mount([asking(item, [ask])], queueOf([ask]));
    try {
      const button = face(container, '6');
      expect(button.classList.contains('min-w-0')).toBe(true);
      expect(button.classList.contains('max-w-full')).toBe(true);
      // The question is cut to its one line (the short ask card, #91), whole in the popover.
      const asked = holding(button, question);
      expect(asked.length).toBeGreaterThan(0);
      for (const el of asked) {
        expect(el.classList.contains('truncate')).toBe(true);
        expect(el.classList.contains('min-w-0')).toBe(true);
      }
      const found = holding(button, label);
      expect(found.length).toBeGreaterThan(0);
      for (const el of found) expect(wrapsAnywhere(el, button)).toBe(true);
      const line = holding(button, label)[0];
      expect(line?.getAttribute('data-mark')).toBe('recommended');
      expect(line?.className).not.toContain('accent');
    } finally {
      await unmount();
    }
  });

  test('several asks: "N questions" and the newest one named', async () => {
    const item = realItem('6');
    const asks = [
      askOn(item, { ref: 'ask:1', pausedAt: '2026-11-16T09:00:00.000Z', message: 'Oldest?' }),
      askOn(item, { ref: 'ask:2', pausedAt: '2026-11-16T10:00:00.000Z', message: 'Middle?' }),
      askOn(item, { ref: 'ask:3', pausedAt: '2026-11-16T11:00:00.000Z', message: 'Newest?' }),
    ];
    const { container, unmount } = await mount([asking(item, asks)], queueOf(asks));
    try {
      const button = face(container, '6');
      expect(button.textContent).toContain('3 questions');
      expect(button.textContent).toContain('Newest?');
      expect(button.textContent).not.toContain('Oldest?');
    } finally {
      await unmount();
    }
  });

  test('the queue not read yet: the card keeps its stop line and no face', async () => {
    const item = realItem('6');
    const ask = askOn(item);
    const { container, unmount } = await mount([asking(item, [ask])], null);
    try {
      expect(card(container, '6').querySelector('button[data-ask-trigger]')).toBeNull();
      expect(card(container, '6').textContent).toContain('Which base should the change target?');
    } finally {
      await unmount();
    }
  });

  test('an ask only the item read lists, not the queue Needs you reads: no face', async () => {
    const item = realItem('6');
    const ask = askOn(item);
    const { container, unmount } = await mount([asking(item, [ask])], queueOf([]));
    try {
      expect(card(container, '6').querySelector('button[data-ask-trigger]')).toBeNull();
    } finally {
      await unmount();
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

  test("opens over the board with that item's asks only, and an empty preview slot", async () => {
    const { container, unmount } = await mount(items, queue);
    try {
      expect(dialog()).toBeNull();
      await click(face(container, '6'));
      const open = dialog();
      expect(open?.getAttribute('aria-label')).toBe('Asks on #6');
      // Portalled to the body, out of the card's clipped box.
      expect(container.contains(open)).toBe(false);
      expect(open?.textContent).toContain('Which base should the change target?');
      expect(open?.textContent).toContain('Use main');
      expect(open?.textContent).toContain('Use dev');
      expect(open?.textContent).not.toContain('Split the item?');
      expect(open?.querySelector('[data-preview-slot]')?.childElementCount).toBe(0);
      expect(face(container, '6').getAttribute('aria-expanded')).toBe('true');
      // Focus moves into it, to the ask card.
      expect(document.activeElement?.getAttribute('data-ask')).toBe('ask:six');
    } finally {
      await unmount();
    }
  });

  test("a stage's drop tile says what it starts, in the view's words", async () => {
    const dropAsk = askOn(six, {
      ref: 'ask:drop',
      askedIn: { runId: 'run-check', workflow: 'Wirasm/archon-software-factory:stage-check' },
      options: [
        { id: 'send-back', does: 'Continues.' },
        { id: 'drop', does: 'Closes it.' },
      ],
      recommendation: { option: 'send-back', why: 'Small.' },
    });
    const { container, unmount } = await mount([asking(six, [dropAsk])], queueOf([dropAsk]));
    try {
      await click(face(container, '6'));
      expect(dialogButton('Send back').querySelector('[data-starts]')).toBeNull();
      expect(dialogButton('Drop').querySelector('[data-starts]')?.textContent).toBe(
        'Closes the PR without merging'
      );
    } finally {
      await unmount();
    }
  });

  test('Esc closes it and focus returns to the card that opened it', async () => {
    const { container, unmount } = await mount(items, queue);
    try {
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

  test('a press outside closes it and focus returns; a press inside does not', async () => {
    const { container, unmount } = await mount(items, queue);
    try {
      const trigger = face(container, '6');
      await click(trigger);
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
      expect(document.activeElement).toBe(trigger);
    } finally {
      await unmount();
    }
  });

  test("the Table's Answer button opens the same popover", async () => {
    const { container, unmount } = await mount(items, queue, '?view=table');
    try {
      const row = container.querySelector<HTMLElement>('tr[data-card="3"]');
      const answer = row?.querySelector<HTMLButtonElement>('button[data-ask-trigger]');
      expect(answer?.textContent).toBe('Answer');
      // Beside the state pill, not in the last column, which a 1440 px window cuts off.
      expect(answer?.closest('td')?.textContent).toContain('Needs you');
      await click(answer!);
      expect(dialog()?.getAttribute('aria-label')).toBe('Asks on #3');
      expect(dialog()?.textContent).toContain('Split the item?');
      expect(dialog()?.textContent).not.toContain('Which base should the change target?');
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

  test('the last ask: the popover closes, the card says what was answered, then what started again', async () => {
    const sent = serveAnswers();
    const { container, unmount } = await mount([asking(waiting, [ask])], queueOf([ask]));
    try {
      await click(face(container, '6'));
      await click(dialogButton('Use dev'));
      await click(dialogButton('Confirm'));
      expect(sent).toEqual(['/api/attention/answer']);
      expect(dialog()).toBeNull();
      expect(card(container, '6').textContent).toContain('Answered: Use dev');
      expect(card(container, '6').querySelector('button[data-ask-trigger]')).toBeNull();

      // The next items read records the settled set and the plan run it started.
      const settled = settledItem(
        '6',
        run('plan', 'completed', 'ask'),
        '2026-11-18T11:00:00.000Z',
        run('plan', 'running', null, 'plan')
      );
      await act(async () => set(K.factoryItems(ID), { items: [settled], members: {} }));
      expect(card(container, '6').textContent).toContain('Answered · Plan started again');

      // A read that moves the card ends it.
      const moved = itemWith('6', [
        run('plan', 'completed', 'ask'),
        run('deliver', 'running', null, 'implement'),
      ]);
      await act(async () => set(K.factoryItems(ID), { items: [moved], members: {} }));
      expect(card(container, '6').textContent).not.toContain('Answered');
    } finally {
      serveAnswers();
      await unmount();
    }
  });

  for (const view of ['', '?view=table'] as const)
    test(`a restart that fails shows what stopped it, not the answer (${view || 'Pipeline'})`, async () => {
      serveAnswers();
      const { container, unmount } = await mount([asking(waiting, [ask])], queueOf([ask]), view);
      const holder = (): HTMLElement => {
        const found = container.querySelector<HTMLElement>(`[data-card="6"]`);
        if (found === null) throw new Error('No card or row 6');
        return found;
      };
      try {
        await click(holder().querySelector<HTMLButtonElement>('button[data-ask-trigger]')!);
        await click(dialogButton('Use dev'));
        await click(dialogButton('Confirm'));
        const started = settledItem(
          '6',
          run('plan', 'completed', 'ask'),
          '2026-11-18T11:00:00.000Z',
          run('plan', 'running', null, 'plan')
        );
        await act(async () => set(K.factoryItems(ID), { items: [started], members: {} }));
        expect(holder().textContent).toContain('Answered · Plan started again');

        // The restarted plan run fails in the same stage: the card does not move.
        const failed = settledItem(
          '6',
          run('plan', 'completed', 'ask'),
          '2026-11-18T11:00:00.000Z',
          run('plan', 'failed', null, 'plan')
        );
        await act(async () => set(K.factoryItems(ID), { items: [failed], members: {} }));
        expect(holder().textContent).toContain('Failed');
        expect(holder().textContent).not.toContain('Answered');
        expect(holder().textContent).toMatch(/failed/);
      } finally {
        serveAnswers();
        await unmount();
      }
    });

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

  test("a paused gate's face says a gate waits for a decision", async () => {
    const gate = gateItem({ item: { id: waiting.item.id, projectKey: 'acme', key: '6' } });
    const { container, unmount } = await mount([asking(waiting, [gate])], queueOf([gate]));
    try {
      expect(face(container, '6').textContent).toContain('A gate waits for your decision');
    } finally {
      await unmount();
    }
  });
});
