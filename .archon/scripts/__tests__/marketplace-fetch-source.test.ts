import { describe, expect, it } from 'bun:test';
import { trackTempRoots } from '@archon/paths/test-utils';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, '../marketplace-fetch-source.ts');

interface FetchOutput {
  files: string[];
  errors: string[];
}

interface FetchResult {
  output: FetchOutput;
  stderr: string;
  exitCode: number;
}

const trackTempRoot = trackTempRoots();

function runFetch(entryJson?: Record<string, unknown>): FetchResult {
  const artifactsDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'fetch-test-')));
  if (entryJson !== undefined) {
    writeFileSync(join(artifactsDir, 'entry.json'), JSON.stringify(entryJson));
  }

  const result = spawnSync('bun', [SCRIPT], {
    env: { ...process.env, ARTIFACTS_DIR: artifactsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const exitCode = result.status ?? 1;
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  const output = stdout
    ? (JSON.parse(stdout) as FetchOutput)
    : { files: [], errors: [] } satisfies FetchOutput;

  return { output, stderr, exitCode };
}

describe('marketplace-fetch-source: guard for missing sourceUrl/sha', () => {
  it('skips entries with either required field missing', () => {
    const cases = [
      { entry: { sha: 'abc123' }, missingFields: ['sourceUrl'] },
      {
        entry: { sourceUrl: 'https://github.com/owner/repo/blob/main/path' },
        missingFields: ['sha'],
      },
      { entry: {}, missingFields: ['sourceUrl', 'sha'] },
    ];

    for (const { entry, missingFields } of cases) {
      const { output, stderr, exitCode } = runFetch(entry);
      expect(exitCode).toBe(0);
      expect(output.files).toHaveLength(0);
      expect(output.errors).toHaveLength(1);
      for (const field of missingFields) {
        expect(stderr).toContain(field);
        expect(output.errors[0]).toContain(field);
      }
    }
  });

  it('does not trigger guard when entry.json has both sourceUrl and sha', () => {
    // Unrecognized URL makes the script stop deterministically at URL validation — no network.
    const { stderr, exitCode } = runFetch({
      sourceUrl: 'https://example.com/not-a-github-url',
      sha: 'abc123def456',
    });
    expect(stderr).not.toContain('missing required field');
    expect(stderr).toContain('Unrecognized sourceUrl format');
    expect(exitCode).toBe(1);
  });
});

describe('marketplace-fetch-source: missing entry.json', () => {
  it('exits 1 when entry.json is absent', () => {
    const { exitCode, stderr } = runFetch();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('entry.json not found');
  });
});
