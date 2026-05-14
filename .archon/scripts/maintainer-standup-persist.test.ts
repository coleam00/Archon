import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Runs the persist script with the given stdin content in a temp directory.
 * Returns { exitCode, stdout, stderr }.
 */
async function runPersist(stdin: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'persist-test-'));
  try {
    const proc = Bun.spawn(
      ['bun', 'run', join(import.meta.dir, 'maintainer-standup-persist.ts')],
      { cwd, stdin: new Response(stdin).body!, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    let stateParsed: unknown = null;
    let briefContent: string | null = null;
    if (exitCode === 0) {
      const meta = JSON.parse(stdout.trim());
      const statePath = join(cwd, meta.state_path);
      const briefPath = join(cwd, meta.brief_path);
      stateParsed = JSON.parse(readFileSync(statePath, 'utf8'));
      briefContent = readFileSync(briefPath, 'utf8');
    }
    return { exitCode, stdout: stdout.trim(), stderr, stateParsed, briefContent };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('maintainer-standup-persist', () => {
  test('single BEGIN/END block succeeds', async () => {
    const input = [
      '# Maintainer Standup — 2026-05-14',
      'All systems operational.',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 1}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.stateParsed).toEqual({ version: 1 });
    expect(result.briefContent).toContain('All systems operational.');
  });

  test('duplicate BEGIN blocks — takes last complete block (fixes #1674)', async () => {
    const input = [
      '# Maintainer Standup — 2026-05-14',
      'Brief content here.',
      'ARCHON_STATE_JSON_BEGIN',
      '{"truncated": true, "partial',  // truncated first emission
      '',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 2, "complete": true}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.stateParsed).toEqual({ version: 2, complete: true });
    expect(result.briefContent).toContain('Brief content here.');
  });

  test('JSON-wrapper fallback works', async () => {
    const input = JSON.stringify({
      brief_markdown: '# Standup\nAll good.',
      next_state: { version: 3 },
    });
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.stateParsed).toEqual({ version: 3 });
    expect(result.briefContent).toContain('All good.');
  });

  test('no valid format exits 1', async () => {
    const result = await runPersist('just some random text with no markers');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('PERSIST FAILED');
  });
});
