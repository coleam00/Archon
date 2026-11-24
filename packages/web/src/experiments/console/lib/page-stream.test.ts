import { expect, test } from 'bun:test';
import { followWhilePageShown } from './page-stream';

function pageShow(persisted: boolean): Event {
  return Object.assign(new Event('pageshow'), { persisted });
}

function follow(): {
  page: EventTarget;
  connects: () => number;
  disconnects: () => number;
  stop: () => void;
} {
  const page = new EventTarget();
  let connects = 0;
  let disconnects = 0;
  const stop = followWhilePageShown(() => {
    connects += 1;
    return (): void => {
      disconnects += 1;
    };
  }, page);
  return { page, connects: () => connects, disconnects: () => disconnects, stop };
}

test('connects at once, and disconnects when the page is hidden', () => {
  const { page, connects, disconnects, stop } = follow();
  expect(connects()).toBe(1);
  page.dispatchEvent(new Event('pagehide'));
  page.dispatchEvent(new Event('pagehide'));
  expect(disconnects()).toBe(1);
  stop();
  expect(disconnects()).toBe(1);
});

test('reconnects only when the page is restored from the back/forward cache', () => {
  const { page, connects, disconnects, stop } = follow();
  page.dispatchEvent(pageShow(false));
  expect(connects()).toBe(1);
  page.dispatchEvent(new Event('pagehide'));
  page.dispatchEvent(pageShow(false));
  expect(connects()).toBe(1);
  page.dispatchEvent(pageShow(true));
  expect(connects()).toBe(2);
  // Already connected: a second restore does not open a second stream.
  page.dispatchEvent(pageShow(true));
  expect(connects()).toBe(2);
  stop();
  expect(disconnects()).toBe(2);
});

test('the cleanup disconnects once and stops listening', () => {
  const { page, connects, disconnects, stop } = follow();
  stop();
  stop();
  expect(disconnects()).toBe(1);
  page.dispatchEvent(pageShow(true));
  page.dispatchEvent(new Event('pagehide'));
  expect(connects()).toBe(1);
  expect(disconnects()).toBe(1);
});
