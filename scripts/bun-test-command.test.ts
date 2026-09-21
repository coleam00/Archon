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

describe('every runner assembles its command through bunTestCommand', () => {
  it('no runner script spells out a bun test command by hand', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    for (const entry of await readdir(import.meta.dir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry === 'bun-test-command.ts')
        continue;
      const source = await readFile(join(import.meta.dir, entry), 'utf8');
      if (/\[\s*'bun'\s*,\s*'test'/.test(source)) offenders.push(entry);
    }
    // A hand-built command on any runner path silently drops the Windows budget for that path.
    expect(offenders).toEqual([]);
  });
});
