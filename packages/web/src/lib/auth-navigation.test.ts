import { expect, test } from 'bun:test';
import { consoleReturnDestination } from './auth-navigation';

test('preserves the console run bookmark, including its query and fragment', () => {
  const returnTo = '/console/r/run-123?view=logs#node-2';
  expect(consoleReturnDestination({ returnTo })).toBe(returnTo);
});

test('direct login and invalid destinations return to the console overview', () => {
  for (const state of [
    undefined,
    null,
    {},
    { returnTo: 3 },
    { returnTo: 'https://example.com/console' },
    { returnTo: '//example.com/console' },
    { returnTo: '/login' },
    { returnTo: '/console/../login' },
  ]) {
    expect(consoleReturnDestination(state)).toBe('/console');
  }
});
