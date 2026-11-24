import { describe, expect, test } from 'bun:test';
import { askItem, gateItem, unreadableItem } from '../../lib/needs-you.test-fixtures';
import type { SettledAsks } from './answered';
import { answeredLine, answerStands, boardAskFace, heldAnswer, popoverPlace } from './board-ask';

describe("a board card's face", () => {
  test('an ask with a recommendation: its question and "Recommended: <label>"', () => {
    expect(boardAskFace([askItem()])).toMatchObject({
      question: 'Which base should the change target?',
      line: 'Recommended: Use dev',
      tile: { recommended: true, detail: 'High confidence. Dev is the working base.' },
      count: 1,
    });
  });

  test('without one: the first declared option, not marked', () => {
    const face = boardAskFace([askItem({ recommendation: undefined })]);
    expect(face).toMatchObject({ line: 'Use main', tile: { recommended: false }, count: 1 });
  });

  test('an answer in words, a gate, and a run it cannot answer each say so; nothing open, no face', () => {
    expect(boardAskFace([askItem({ form: 'message', options: [] })])?.line).toBe('Answer in words');
    expect(boardAskFace([gateItem()])).toMatchObject({
      question: 'Approve the plan?',
      line: 'A gate waits for your decision',
    });
    expect(boardAskFace([unreadableItem()])).toMatchObject({
      question: 'This paused run could not be read',
      line: 'Resume or abandon it on the run',
    });
    expect(boardAskFace([])).toBeNull();
  });
});

describe('an answer held on the card', () => {
  const ask = askItem({ askedIn: { runId: 'run-ask', workflow: 'plan' } });
  const held = heldAnswer(ask, 'Use dev', 'plan', [ask]);
  const settled = (restart: SettledAsks['restart'], runId = 'run-ask'): SettledAsks => ({
    itemKey: '#7',
    runId,
    title: null,
    partOf: null,
    answered: 1,
    withdrawn: 0,
    at: '2026-11-18T10:00:00.000Z',
    askedAt: null,
    asks: [],
    restart,
    restarts: restart === null ? 0 : 1,
  });
  const restart = { runId: 'run-again', status: 'running' as const, label: 'Plan' };
  const declared = (starts: (string | null)[]): SettledAsks => ({
    ...settled(restart),
    asks: starts.map((sentence, index) => ({
      question: `Question ${index.toString()}?`,
      answer: 'Drop',
      withdrawn: false,
      at: '2026-11-18T10:00:00.000Z',
      by: null,
      starts: sentence,
    })),
  });

  test('says what was answered until the read records the restart of the asking run', () => {
    expect(answeredLine(held, [])).toBe('Answered: Use dev');
    expect(answeredLine(held, [settled(restart, 'run-other')])).toBe('Answered: Use dev');
    expect(answeredLine(held, [settled(restart)])).toBe('Answered · Plan started again');
  });

  test("an option the view words reads the view's sentence", () => {
    const drop = 'Closes the PR without merging';
    expect(answeredLine(held, [declared([drop, null])])).toBe(`Answered · ${drop}`);
  });

  test('stands until the card moves or the item asks something new', () => {
    expect(answerStands(held, 'plan', [ask])).toBe(true);
    expect(answerStands(held, 'plan', [])).toBe(true);
    expect(answerStands(held, 'build', [])).toBe(false);
    expect(answerStands(held, 'plan', [askItem({ ref: 'ask:new' })])).toBe(false);
  });
});

test('the popover sits right of the card when it fits, else left, always inside the window', () => {
  const viewport = { width: 1440, height: 900 };
  const box = { width: 480, height: 400 };
  const inside = (place: { top: number; left: number }) =>
    place.top >= 0 &&
    place.left >= 0 &&
    place.top + box.height <= viewport.height &&
    place.left + box.width <= viewport.width;
  const card = { top: 200, left: 300, right: 508, bottom: 340 };
  const right = popoverPlace(card, box, viewport);
  expect(right.left).toBeGreaterThan(card.right);
  const nearEdge = { top: 200, left: 1100, right: 1308, bottom: 340 };
  expect(popoverPlace(nearEdge, box, viewport).left + box.width).toBeLessThan(nearEdge.left);
  for (const top of [-40, 200, 800])
    expect(inside(popoverPlace({ ...card, top }, box, viewport))).toBe(true);
});
