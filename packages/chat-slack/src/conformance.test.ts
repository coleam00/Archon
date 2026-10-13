import { expect, test } from 'bun:test';
import { conformance } from './test/conformance';

test('Slack source process passes chat conformance with a stubbed Slack client', async () => {
  expect(await conformance()).toEqual([]);
});

test('unmodified source initializes without tokens and fails start non-retryably', async () => {
  const { resolve } = await import('node:path');
  const { smoke } = await import('./test/smoke');
  await smoke([process.execPath, resolve(import.meta.dir, 'main.ts')]);
});
