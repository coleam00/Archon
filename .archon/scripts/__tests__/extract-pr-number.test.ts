import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, '../extract-pr-number.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  prNumberFile?: string;
}

function run(input: string, withArtifacts = false): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['ARGUMENTS'];
  let artifactsDir: string | undefined;
  if (withArtifacts) {
    artifactsDir = mkdtempSync(join(tmpdir(), 'extract-pr-'));
    env['ARTIFACTS_DIR'] = artifactsDir;
  } else {
    delete env['ARTIFACTS_DIR'];
  }
  try {
    const stdout = execFileSync('bun', [SCRIPT, input], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    let prNumberFile: string | undefined;
    if (artifactsDir) {
      try {
        prNumberFile = readFileSync(join(artifactsDir, '.pr-number'), 'utf8');
      } catch {
        prNumberFile = undefined;
      }
    }
    return { code: 0, stdout, stderr: '', prNumberFile };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: err.status ?? 1,
      stdout: (err.stdout ?? Buffer.from('')).toString(),
      stderr: (err.stderr ?? Buffer.from('')).toString(),
    };
  }
}

describe('extract-pr-number: anchored forms win', () => {
  it('#1428', () => expect(run('#1428').stdout.trim()).toBe('1428'));
  it('PR 1428', () => expect(run('review PR 1428 as maintainer').stdout.trim()).toBe('1428'));
  it('PR#1428', () => expect(run('PR#1428').stdout.trim()).toBe('1428'));
  it('PR-1428', () => expect(run('PR-1428').stdout.trim()).toBe('1428'));
  it('pull URL with coleam00 org (naive grep would return 00)', () =>
    expect(run('https://github.com/coleam00/Archon/pull/1428').stdout.trim()).toBe('1428'));
  it('issues URL', () =>
    expect(run('https://github.com/coleam00/Archon/issues/1428').stdout.trim()).toBe('1428'));
  it('pr2-tool slug does not win over pull/1428 (S3 precedence)', () =>
    expect(run('https://github.com/pr2-tool/Archon/pull/1428').stdout.trim()).toBe('1428'));
  it('ignores an unanchored digit token when an anchor is present', () =>
    expect(run('the 2nd one, pr #1428').stdout.trim()).toBe('1428'));
});

describe('extract-pr-number: bare number only when whole input', () => {
  it('accepts a pure number', () => expect(run('1428').stdout.trim()).toBe('1428'));
});

describe('extract-pr-number: loud errors (no silent wrong number)', () => {
  it('errors on anchor-less prose with a leading digit token (I1: coleam00 fix 1428)', () => {
    const r = run('coleam00 fix 1428');
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('no PR number found');
  });

  it('errors on a version string with a trailing number (I1: v1.2.3 changelog for 1428)', () => {
    const r = run('v1.2.3 changelog for 1428');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no PR number found');
  });

  it('errors on ambiguous multi-number input, listing them (I2)', () => {
    const r = run('see #1400, should relate to PR 1428');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('ambiguous');
    expect(r.stderr).toContain('1400');
    expect(r.stderr).toContain('1428');
  });

  it('errors on empty input', () => {
    const r = run('   ');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('empty input');
  });
});

describe('extract-pr-number: writes .pr-number', () => {
  it('writes the number to $ARTIFACTS_DIR/.pr-number', () => {
    const r = run('https://github.com/coleam00/Archon/pull/1428', true);
    expect(r.code).toBe(0);
    expect(r.prNumberFile?.trim()).toBe('1428');
  });
});
