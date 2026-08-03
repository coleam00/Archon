import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  test('no valid format exits 1', async () => {
    const result = await runPersist('just some random text with no markers');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('PERSIST FAILED');
  });

  test('marker substring in brief prose before real marker — not confused', async () => {
    const input = [
      '# Maintainer Standup — 2026-05-15',
      'PR #1676 — fix(scripts): handle duplicate ARCHON_STATE_JSON_BEGIN blocks in persist — merged ✓',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 4}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.stateParsed).toEqual({ version: 4 });
    expect(result.briefContent).toContain('PR #1676');
    expect(result.briefContent).not.toContain('"version"');
  });

  test('marker substring inside state JSON string value — not confused', async () => {
    // Marker inline in compact JSON (not on its own line) — line-anchored regex doesn't match it; defence-in-depth.
    const stateJson = JSON.stringify({
      version: 5,
      observed_prs: [
        {
          number: 1676,
          title:
            'fix(scripts): handle duplicate ARCHON_STATE_JSON_BEGIN blocks in persist',
        },
      ],
    });
    const input = [
      '# Maintainer Standup — 2026-05-15',
      'All systems nominal.',
      'ARCHON_STATE_JSON_BEGIN',
      stateJson,
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect((result.stateParsed as { version: number }).version).toBe(5);
  });

  test('BEGIN present but END absent (truncated output) — falls through to error', async () => {
    const input = [
      '# Standup',
      'ARCHON_STATE_JSON_BEGIN',
      '{"truncated": true', // no END marker — simulates context-length truncation
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('PERSIST FAILED');
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

  test('duplicate BEGIN blocks AND marker in prose — last complete pair wins', async () => {
    const input = [
      '# Maintainer Standup — 2026-05-15',
      'Merged PR #1676 which fixes ARCHON_STATE_JSON_BEGIN duplicate blocks.',
      'ARCHON_STATE_JSON_BEGIN',
      '{"truncated": true, "partial',
      '',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 6}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.stateParsed).toEqual({ version: 6 });
  });
});
