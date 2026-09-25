import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const CANCELLED = Symbol('cancelled');
const noop = (): void => undefined;
mock.module('@clack/prompts', () => ({
  intro: noop,
  outro: noop,
  note: noop,
  cancel: noop,
  log: { info: noop, warn: noop, error: noop, success: noop, message: noop, step: noop },
  spinner: () => ({ start: noop, stop: noop, message: noop }),
  select: async () => CANCELLED,
  multiselect: async () => CANCELLED,
  text: async () => CANCELLED,
  password: async () => CANCELLED,
  confirm: async () => CANCELLED,
  isCancel: (value: unknown) => value === CANCELLED,
}));

const { setupCommand } = await import('./setup');
const tempRoots = trackTempRoots();

describe('setupCommand exit', () => {
  // bun test exits 0 when code under test calls process.exit(0), so a
  // regression back to process.exit would otherwise pass silently.
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code}) called`);
  }) as typeof process.exit);
  afterEach(() => exitSpy.mockClear());

  test('a cancelled prompt resolves to exit code 0 instead of exiting the process', async () => {
    const repoPath = tempRoots(mkdtempSync(join(tmpdir(), 'archon-setup-exit-')));
    mkdirSync(join(repoPath, '.archon'), { recursive: true });
    writeFileSync(join(repoPath, '.archon', '.env'), 'CLAUDE_USE_GLOBAL_AUTH=true\n');

    // process.exit would end the CLI before main()'s finally flushes telemetry.
    expect(await setupCommand({ repoPath, scope: 'project' })).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
