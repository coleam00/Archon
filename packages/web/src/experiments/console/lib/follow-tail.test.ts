import { describe, expect, test } from 'bun:test';
import { followTail } from './follow-tail';

describe('followTail', () => {
  test('retains following intent when content grows beyond the near-bottom threshold', () => {
    const viewport = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
    viewport.scrollHeight += 300;

    followTail(viewport, true);

    expect(viewport.scrollTop).toBe(1300);
    viewport.scrollHeight += 200;
    followTail(viewport, true);
    expect(viewport.scrollTop).toBe(1500);
  });

  test('leaves detached content in place until explicitly repinned', () => {
    const viewport = { scrollTop: 200, scrollHeight: 1000 };
    viewport.scrollHeight += 300;

    followTail(viewport, false);

    expect(viewport.scrollTop).toBe(200);
    followTail(viewport, true);
    expect(viewport.scrollTop).toBe(1300);
    viewport.scrollHeight += 200;
    followTail(viewport, true);
    expect(viewport.scrollTop).toBe(1500);
  });
});
