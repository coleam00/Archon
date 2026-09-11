import { describe, expect, it } from 'bun:test';
import { bunTestCommand, WINDOWS_TEST_TIMEOUT_MS } from './bun-test-command';

describe('bunTestCommand', () => {
  it('widens the default per-test budget on Windows only', () => {
    expect(bunTestCommand(['src/a.test.ts'], 'win32')).toEqual([
      'bun',
      'test',
      '--timeout',
      String(WINDOWS_TEST_TIMEOUT_MS),
      'src/a.test.ts',
    ]);
    expect(bunTestCommand(['src/a.test.ts'], 'linux')).toEqual(['bun', 'test', 'src/a.test.ts']);
    expect(bunTestCommand(['src/a.test.ts'], 'darwin')).toEqual(['bun', 'test', 'src/a.test.ts']);
  });

  it('forwards selectors and flags verbatim after the budget', () => {
    expect(bunTestCommand(['--bail', 'logger'], 'win32')).toEqual([
      'bun',
      'test',
      '--timeout',
      String(WINDOWS_TEST_TIMEOUT_MS),
      '--bail',
      'logger',
    ]);
  });
});
