import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, '../marketplace-fetch-source.ts');

interface FetchOutput {
  files: string[];
  errors: string[];
}

function runFetch(entryJson: Record<string, unknown>): { output: FetchOutput; stderr: string; exitCode: number } {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'fetch-test-'));
  try {
    mkdirSync(join(artifactsDir, 'source'), { recursive: true });
    writeFileSync(join(artifactsDir, 'entry.json'), JSON.stringify(entryJson));

    const result = spawnSync('bun', [SCRIPT], {
      env: { ...process.env, ARTIFACTS_DIR: artifactsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const exitCode = result.status ?? 1;
    const stdout = result.stdout?.toString() ?? '';
    const stderr = result.stderr?.toString() ?? '';

    let output: FetchOutput = { files: [], errors: [] };
    if (stdout) {
      try {
        output = JSON.parse(stdout);
      } catch {}
    }

    return { output, stderr, exitCode };
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
}

describe('marketplace-fetch-source: guard for missing sourceUrl/sha', () => {
  it('exits 0 with empty files when sourceUrl is missing', () => {
    const { output, stderr, exitCode } = runFetch({ sha: 'abc123' });
    expect(exitCode).toBe(0);
    expect(output.files).toHaveLength(0);
    expect(stderr).toContain('sourceUrl');
    expect(output.errors.length).toBeGreaterThan(0);
    expect(output.errors[0]).toContain('sourceUrl');
  });

  it('exits 0 with empty files when sha is missing', () => {
    const { output, stderr, exitCode } = runFetch({ sourceUrl: 'https://github.com/owner/repo/blob/main/path' });
    expect(exitCode).toBe(0);
    expect(output.files).toHaveLength(0);
    expect(stderr).toContain('sha');
    expect(output.errors.length).toBeGreaterThan(0);
    expect(output.errors[0]).toContain('sha');
  });

  it('exits 0 with empty files when both sourceUrl and sha are missing', () => {
    const { output, stderr, exitCode } = runFetch({});
    expect(exitCode).toBe(0);
    expect(output.files).toHaveLength(0);
    expect(stderr).toContain('sourceUrl');
    expect(stderr).toContain('sha');
    expect(output.errors.length).toBeGreaterThan(0);
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
    const artifactsDir = mkdtempSync(join(tmpdir(), 'fetch-test-'));
    try {
      const result = spawnSync('bun', [SCRIPT], {
        env: { ...process.env, ARTIFACTS_DIR: artifactsDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(result.status ?? 1).toBe(1);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
