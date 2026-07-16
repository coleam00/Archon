import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TARGET = '.archon/state/triage-state.json';

async function runPersist(stdin: string, target = TARGET, seed?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'triage-persist-test-'));
  try {
    if (seed !== undefined) {
      mkdirSync(join(cwd, '.archon/state'), { recursive: true });
      writeFileSync(join(cwd, target), seed);
    }
    const proc = Bun.spawn(
      ['bun', 'run', join(import.meta.dir, 'repo-triage-persist.ts'), '--target', target],
      { cwd, stdin: new Response(stdin).body!, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    let written: unknown = null;
    if (exitCode === 0) {
      written = JSON.parse(readFileSync(join(cwd, target), 'utf8'));
    }
    const targetExists = existsSync(join(cwd, target));
    let onDiskRaw: string | null = null;
    if (targetExists) onDiskRaw = readFileSync(join(cwd, target), 'utf8');
    return { exitCode, stdout: stdout.trim(), stderr, written, onDiskRaw };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('repo-triage-persist', () => {
  test('delimited state block is written', async () => {
    const input = [
      '## Issue triage — 2026-07-16',
      'Dedup comments posted: 1',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 1, "lastRunAt": "2026-07-16T00:00:00Z", "pendingDedupComments": {"42": {"canonical": 7}}}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.written).toEqual({
      version: 1,
      lastRunAt: '2026-07-16T00:00:00Z',
      pendingDedupComments: { '42': { canonical: 7 } },
    });
    // stdout meta reports the source + target
    expect(JSON.parse(result.stdout)).toMatchObject({ target: TARGET, source: 'delimiter' });
  });

  test('duplicate BEGIN blocks — last complete pair wins', async () => {
    const input = [
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 1, "partial',
      '',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 2, "complete": true}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.written).toEqual({ version: 2, complete: true });
  });

  test('bare-JSON fallback (Pi/Minimax format) with trailing prose', async () => {
    const input =
      'Here is the updated state:\n{"version": 1, "briefs": {"9": {"area": "core"}}}\nDone.';
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.written).toEqual({ version: 1, briefs: { '9': { area: 'core' } } });
    expect(JSON.parse(result.stdout)).toMatchObject({ source: 'bare-json' });
  });

  test('marker substring in prose before the real block — not confused', async () => {
    const input = [
      'Note: PR mentions ARCHON_STATE_JSON_BEGIN in its title.',
      'ARCHON_STATE_JSON_BEGIN',
      '{"version": 3}',
      'ARCHON_STATE_JSON_END',
    ].join('\n');
    const result = await runPersist(input);
    expect(result.exitCode).toBe(0);
    expect(result.written).toEqual({ version: 3 });
  });

  test('no extractable JSON exits 1 and leaves prior state intact', async () => {
    const seed = '{"version": 1, "keep": "me"}\n';
    const result = await runPersist('no json here at all', TARGET, seed);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('PERSIST FAILED');
    // The pre-existing state file must be untouched (atomic write never started).
    expect(result.onDiskRaw).toBe(seed);
  });

  test('BEGIN present but END absent (truncated) — exits 1, state intact', async () => {
    const seed = '{"version": 1, "keep": "me"}\n';
    const input = ['ARCHON_STATE_JSON_BEGIN', '{"version": 9, "partial'].join('\n');
    const result = await runPersist(input, TARGET, seed);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('PERSIST FAILED');
    expect(result.onDiskRaw).toBe(seed);
  });

  test('rejects a --target outside .archon/state/', async () => {
    const result = await runPersist(
      'ARCHON_STATE_JSON_BEGIN\n{"x":1}\nARCHON_STATE_JSON_END',
      '.archon/config.yaml',
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('must resolve under .archon/state/');
  });

  test('rejects path traversal in --target', async () => {
    const result = await runPersist(
      'ARCHON_STATE_JSON_BEGIN\n{"x":1}\nARCHON_STATE_JSON_END',
      '.archon/state/../../etc/evil.json',
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('must resolve under .archon/state/');
  });

  test('missing --target exits 1', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'triage-persist-test-'));
    try {
      const proc = Bun.spawn(
        ['bun', 'run', join(import.meta.dir, 'repo-triage-persist.ts')],
        { cwd, stdin: new Response('{"x":1}').body!, stdout: 'pipe', stderr: 'pipe' },
      );
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--target');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('writes a nested state target atomically (no leftover temp files)', async () => {
    const input = 'ARCHON_STATE_JSON_BEGIN\n{"version":1,"nudged":{}}\nARCHON_STATE_JSON_END';
    const result = await runPersist(input, '.archon/state/stale-nudge-state.json');
    expect(result.exitCode).toBe(0);
    expect(result.written).toEqual({ version: 1, nudged: {} });
  });
});
