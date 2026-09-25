import { describe, expect, test } from 'bun:test';
import { trackTempRoots } from '@archon/paths/test-utils';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface PersistResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stateParsed: unknown;
  briefContent: string | null;
}

const trackTempRoot = trackTempRoots();

async function runPersist(stdin: string): Promise<PersistResult> {
  const cwd = trackTempRoot(mkdtempSync(join(tmpdir(), 'persist-test-')));
  const proc = Bun.spawn(
    ['bun', 'run', join(import.meta.dir, 'maintainer-standup-persist.ts')],
    { cwd, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let stateParsed: unknown = null;
  let briefContent: string | null = null;
  if (exitCode === 0) {
    const meta = JSON.parse(stdout.trim()) as {
      state_path: string;
      brief_path: string;
    };
    const statePath = join(cwd, meta.state_path);
    const briefPath = join(cwd, meta.brief_path);
    stateParsed = JSON.parse(readFileSync(statePath, 'utf8'));
    briefContent = readFileSync(briefPath, 'utf8');
  }
  return { exitCode, stdout: stdout.trim(), stderr, stateParsed, briefContent };
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
      '{"truncated": true, "partial',
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

  test('rejects unrecognized and truncated output', async () => {
    const inputs = [
      'just some random text with no markers',
      ['# Standup', 'ARCHON_STATE_JSON_BEGIN', '{"truncated": true'].join('\n'),
    ];

    for (const input of inputs) {
      const result = await runPersist(input);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('PERSIST FAILED');
    }
  });

  test('marker text inside brief and state content is not treated as a delimiter', async () => {
    const nextState = {
      version: 4,
      title: 'fix ARCHON_STATE_JSON_BEGIN handling',
    };
    const input = [
      '# Maintainer Standup — 2026-05-15',
      'PR #1676 — fix(scripts): handle duplicate ARCHON_STATE_JSON_BEGIN blocks in persist — merged ✓',
      'ARCHON_STATE_JSON_BEGIN',
      JSON.stringify(nextState),
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.stateParsed).toEqual(nextState);
    expect(result.briefContent).toContain('PR #1676');
  });

  test('prose preamble before first heading is stripped from brief', async () => {
    const input = [
      'Some preamble text before the heading.',
      '# Maintainer Standup — 2026-05-15',
      'Actual content.',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 7}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.briefContent).not.toContain('preamble');
    expect(result.briefContent).toContain('# Maintainer Standup');
    expect(result.briefContent).toContain('Actual content.');
  });
});
