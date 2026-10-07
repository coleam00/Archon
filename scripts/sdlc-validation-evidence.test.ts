import { describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { Applicability } from '../.archon/workflows/sdlc/.shared/validation-evidence';

/**
 * archon-validate's verdict reuse, run as the engine runs the scripts: a Bun
 * subprocess in a real git checkout, bindings in env, the result on stdout.
 * `applicability.ts` decides; `result.ts` records a fresh verdict and returns a
 * reused one. The deliver pack's `final-gate.ts` decides whether the final gate runs.
 */
const track = trackTempRoots();
const SDLC = join(import.meta.dir, '..', '.archon', 'workflows', 'sdlc');
const VALIDATE = join(SDLC, 'validate', 'scripts');

interface Fixture {
  cwd: string;
  artifacts: string;
  root: string;
}

function git(cwd: string, ...args: string[]): void {
  const out = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr.toString()}`);
}

function repository(): Fixture {
  const root = track(mkdtempSync(join(tmpdir(), 'validation-evidence-')));
  const cwd = join(root, 'repo');
  const artifacts = join(root, 'artifacts');
  mkdirSync(cwd);
  mkdirSync(artifacts);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Archon Test');
  writeFileSync(join(cwd, 'source.ts'), 'export const value = 1;\n');
  git(cwd, 'add', 'source.ts');
  git(cwd, 'commit', '-qm', 'fixture');
  return { cwd, artifacts, root };
}

function exec(
  f: Fixture,
  script: string,
  bindings: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const out = Bun.spawnSync([process.execPath, script], {
    cwd: f.cwd,
    env: { ...(process.env as Record<string, string>), ARTIFACTS_DIR: f.artifacts, ...bindings },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: out.exitCode,
    stdout: out.stdout.toString().trim(),
    stderr: out.stderr.toString(),
  };
}

function check(f: Fixture, scope = '', context = '', dir = VALIDATE): Applicability {
  const out = exec(f, join(dir, 'applicability.ts'), {
    INPUTS_SCOPE: scope,
    INPUTS_CONTEXT: context,
  });
  if (out.exitCode !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout) as Applicability;
}

type Gate = 'green' | 'red' | 'no-checks';

/** The fresh-verdict half of `result`: the gate's outcome as run/classify report it. */
function result(
  f: Fixture,
  applicability: Applicability,
  gate: Gate = 'green',
  dir = VALIDATE
): { exitCode: number; output: Record<string, unknown> | null; stderr: string } {
  const reuse = applicability.reuse;
  const out = exec(f, join(dir, 'result.ts'), {
    INPUTS_SCOPE: applicability.scope,
    INPUTS_CONTEXT: applicability.context,
    INPUTS_COMPARISON: 'null',
    INPUTS_APPLICABILITY: JSON.stringify(applicability),
    INPUTS_DISCOVERY: reuse
      ? 'null'
      : JSON.stringify({
          checks: gate === 'no-checks' ? [] : [{ name: 'gate', argv: ['gate'] }],
          notes: '',
        }),
    INPUTS_RUN: reuse
      ? 'null'
      : JSON.stringify({
          status: gate === 'red' ? 'red' : 'green',
          summary: gate === 'red' ? 'gate failed' : 'gate passed',
        }),
    INPUTS_CLASSIFICATION:
      !reuse && gate === 'red'
        ? JSON.stringify({ red_cause: 'introduced', summary: 'the change broke it' })
        : 'null',
  });
  return {
    exitCode: out.exitCode,
    output: out.stdout === '' ? null : (JSON.parse(out.stdout) as Record<string, unknown>),
    stderr: out.stderr,
  };
}

/** Validate fresh: write the report the runner would, then let `result` record it. */
function record(
  f: Fixture,
  applicability: Applicability,
  gate: Gate = 'green',
  report = 'bun run validate: passed\n',
  dir = VALIDATE
): Record<string, unknown> {
  writeFileSync(join(f.artifacts, 'validation.md'), report);
  const out = result(f, applicability, gate, dir);
  if (out.exitCode !== 0 || out.output === null) throw new Error(out.stderr);
  return out.output;
}

describe('validation evidence applicability', () => {
  it('reuses a green verdict only with its exact nonempty report', () => {
    const f = repository();
    const first = check(f, 'packages/web');
    expect(first).toMatchObject({ generation: 1, reuse: false });
    expect(first.reason).toBe('first validation for this run');
    const fresh = record(f, first);
    expect(fresh).toEqual({
      green: true,
      checks_performed: true,
      red_cause: '',
      summary: 'gate passed',
      evidence: null,
    });

    const reusable = check(f, 'packages/web');
    expect(reusable).toMatchObject({
      fingerprint: first.fingerprint,
      generation: first.generation,
      nonce: first.nonce,
      reuse: true,
      reason: 'applicable evidence',
    });
    // Deciding again is stable, so a cached downstream is not invalidated for nothing.
    expect(check(f, 'packages/web')).toEqual(reusable);
    // The reused verdict is the recorded one, re-checked, with nothing run.
    expect(result(f, reusable).output).toEqual(fresh);

    const stored = JSON.parse(
      readFileSync(join(f.artifacts, 'validation-evidence.json'), 'utf8')
    ) as { applicability: Applicability; report: { content: string; sha256: string } };
    expect(stored.applicability).toEqual(first);
    expect(stored.report.content).toBe('bun run validate: passed\n');
    expect(stored.report.sha256).toBe(
      'e37e1de5075ca27a66d373e77b39d038ca27d54ee9b93e7ff53ba64bfc88c7da'
    );

    writeFileSync(join(f.artifacts, 'validation.md'), 'changed report\n');
    expect(check(f, 'packages/web')).toMatchObject({
      generation: 2,
      reason: 'validation report changed',
      reuse: false,
    });
  });

  it('invalidates changed tracked source, scope, and external context', () => {
    const f = repository();
    const first = check(f, 'packages/web', 'db:snapshot-1');
    record(f, first);

    writeFileSync(join(f.cwd, 'source.ts'), 'export const value = 2;\n');
    const sourceChanged = check(f, 'packages/web', 'db:snapshot-1');
    expect(sourceChanged).toMatchObject({ generation: 2, reason: 'tracked tree changed' });
    record(f, sourceChanged);

    const scopeChanged = check(f, 'packages/core', 'db:snapshot-1');
    expect(scopeChanged).toMatchObject({ generation: 3, reason: 'validation scope changed' });
    record(f, scopeChanged);

    const contextChanged = check(f, 'packages/core', 'db:snapshot-2');
    expect(contextChanged).toMatchObject({ generation: 4, reason: 'validation context changed' });
  });

  it('ignores untracked files, which the run itself injects', () => {
    const f = repository();
    record(f, check(f));
    writeFileSync(join(f.cwd, 'scaffolding.txt'), 'run machinery\n');
    expect(check(f)).toMatchObject({ reuse: true });
  });

  it('invalidates when the packaged validator source changes', () => {
    const f = repository();
    const pack = join(f.root, 'pack');
    cpSync(join(SDLC, 'validate'), join(pack, 'validate'), { recursive: true });
    cpSync(join(SDLC, '.shared'), join(pack, '.shared'), { recursive: true });
    const scripts = join(pack, 'validate', 'scripts');

    record(f, check(f, '', '', scripts), 'green', 'passed\n', scripts);
    expect(check(f, '', '', scripts)).toMatchObject({ reuse: true });
    writeFileSync(join(pack, 'validate', 'commands', 'discover-checks.md'), 'changed\n');
    expect(check(f, '', '', scripts)).toMatchObject({
      generation: 2,
      reason: 'validator changed',
      reuse: false,
    });
  });

  it('still decides when the validator commands are not on disk, as in a packaged binary', () => {
    const f = repository();
    const pack = join(f.root, 'pack');
    cpSync(join(SDLC, 'validate', 'scripts'), join(pack, 'validate', 'scripts'), {
      recursive: true,
    });
    cpSync(join(SDLC, '.shared'), join(pack, '.shared'), { recursive: true });
    const scripts = join(pack, 'validate', 'scripts');
    record(f, check(f, '', '', scripts), 'green', 'passed\n', scripts);
    expect(check(f, '', '', scripts)).toMatchObject({ reuse: true });
  });

  it('invalidates missing report/evidence and non-green or checkless verdicts', () => {
    const f = repository();
    record(f, check(f));

    rmSync(join(f.artifacts, 'validation.md'));
    const missingReport = check(f);
    expect(missingReport).toMatchObject({
      generation: 2,
      reason: 'validation report is missing or empty',
    });
    record(f, missingReport);

    rmSync(join(f.artifacts, 'validation-evidence.json'));
    const missingEvidence = check(f);
    expect(missingEvidence).toMatchObject({
      generation: 3,
      reason: 'validation evidence is missing',
    });
    record(f, missingEvidence, 'red');

    const red = check(f);
    expect(red).toMatchObject({ generation: 4, reason: 'prior validation was not green' });
    expect(record(f, red, 'no-checks')).toMatchObject({ green: true, checks_performed: false });
    expect(check(f)).toMatchObject({
      generation: 5,
      reason: 'prior validation performed no checks',
      reuse: false,
    });
  });

  it('records nothing for a missing report or a tree that moved under the gate', () => {
    const f = repository();
    const applicability = check(f);
    const noReport = result(f, applicability);
    expect(noReport.exitCode).toBe(0);
    expect(noReport.output).toMatchObject({ green: true });
    expect(noReport.stderr).toContain('validation.md is missing or empty');

    writeFileSync(join(f.artifacts, 'validation.md'), 'passed before mutation\n');
    writeFileSync(join(f.cwd, 'source.ts'), 'export const value = 3;\n');
    const moved = result(f, applicability);
    expect(moved.exitCode).toBe(0);
    expect(moved.stderr).toContain('the tracked tree changed while validation was running');
    expect(check(f)).toMatchObject({ reuse: false, reason: 'tracked tree changed' });
  });

  it('refuses a reuse decision whose evidence no longer applies', () => {
    const f = repository();
    record(f, check(f));
    const reusable = check(f);
    expect(reusable.reuse).toBe(true);
    writeFileSync(join(f.cwd, 'source.ts'), 'export const value = 4;\n');
    const out = result(f, reusable);
    expect(out.exitCode).not.toBe(0);
    expect(out.output).toBeNull();
    expect(out.stderr).toContain('no longer applicable');
  });
});

describe('deliver final-gate', () => {
  const finalGate = join(SDLC, 'deliver', 'scripts', 'final-gate.ts');
  function decide(fork: string, policy: string): { exitCode: number; stdout: string } {
    const f = { cwd: tmpdir(), artifacts: tmpdir(), root: tmpdir() };
    return exec(f, finalGate, { INPUTS_FORK: fork, INPUTS_POLICY: policy });
  }

  it('runs the final gate on forks by default and on every delivery when asked', () => {
    expect(decide('true', 'auto').stdout).toBe('{"validate":true}');
    expect(decide('false', 'auto').stdout).toBe('{"validate":false}');
    expect(decide('false', 'always').stdout).toBe('{"validate":true}');
    expect(decide('true', 'always').stdout).toBe('{"validate":true}');
  });

  it('refuses a policy it does not know rather than skipping the gate', () => {
    const out = decide('false', 'allways');
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).toBe('');
  });
});
