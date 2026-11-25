import { describe, expect, test } from 'bun:test';
import { createThrottledInvalidator } from './throttled-invalidator';

function harness(hidden = false) {
  const invalidated: string[] = [];
  const timers: (() => void)[] = [];
  const page = { hidden };
  const invalidator = createThrottledInvalidator({
    invalidate: key => invalidated.push(key),
    isHidden: () => page.hidden,
    setTimer: callback => {
      timers.push(callback);
    },
  });
  const elapse = (): void => {
    for (const callback of timers.splice(0)) callback();
  };
  return { invalidator, invalidated, page, elapse };
}

describe('createThrottledInvalidator', () => {
  test('a visible tab refetches at once', () => {
    const { invalidator, invalidated } = harness();

    invalidator.invalidate('runs');

    expect(invalidated).toEqual(['runs']);
  });

  test('a hidden tab refetches nothing until shown, then each held key once', () => {
    const { invalidator, invalidated, page } = harness(true);

    invalidator.invalidate('runs');
    invalidator.invalidate('run:a');
    invalidator.invalidate('runs');
    expect(invalidated).toEqual([]);

    page.hidden = false;
    invalidator.shown();

    expect(invalidated).toEqual(['runs', 'run:a']);
    invalidator.shown();
    expect(invalidated).toEqual(['runs', 'run:a']);
  });

  test('a burst on a visible tab refetches once now and once when the window ends', () => {
    const { invalidator, invalidated, elapse } = harness();

    for (let i = 0; i < 5; i++) invalidator.invalidate('runs');
    expect(invalidated).toEqual(['runs']);

    elapse();
    expect(invalidated).toEqual(['runs', 'runs']);

    elapse();
    expect(invalidated).toEqual(['runs', 'runs']);
    invalidator.invalidate('runs');
    expect(invalidated).toEqual(['runs', 'runs', 'runs']);
  });

  test('a window that ends while the tab is hidden holds its refetch until shown', () => {
    const { invalidator, invalidated, page, elapse } = harness();

    invalidator.invalidate('runs');
    invalidator.invalidate('runs');
    page.hidden = true;
    elapse();
    expect(invalidated).toEqual(['runs']);

    page.hidden = false;
    invalidator.shown();
    expect(invalidated).toEqual(['runs', 'runs']);
  });
});
