import { expect, test } from 'bun:test';
import { diagnoseOpencode } from './diagnostics';

test('OpenCode diagnostics retain the cheap runtime probe outcomes', async () => {
  for (const [availability, status, message] of [
    ['ready', 'ok', 'server not started'],
    ['executable-missing', 'fail', 'executable not found'],
    ['sdk-entrypoint-missing', 'fail', 'createOpencode entrypoint is missing'],
  ] as const) {
    const result = await diagnoseOpencode(new AbortController().signal, async () => availability);
    expect(result.checks[0].status).toBe(status);
    expect(result.checks[0].message).toContain(message);
  }
});

test('OpenCode probe failures preserve the evidence and repair command', async () => {
  const result = await diagnoseOpencode(new AbortController().signal, async () => {
    throw new Error('module missing');
  });
  expect(result.checks[0]).toMatchObject({
    status: 'fail',
    message: 'runtime SDK not resolvable: module missing',
    remedy: 'Reinstall dependencies (bun install).',
  });
});
