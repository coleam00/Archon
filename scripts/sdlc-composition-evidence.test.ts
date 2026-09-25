import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  compareComposition,
  comparisonVerdict,
  evidenceMatches,
  parseCompositionRequest,
  VALIDATION_RED_CAUSES,
  type CompositionRequest,
  type CompositionEvidence,
} from '../.archon/workflows/sdlc/.shared/composition';
import {
  PASSES_RED,
  passesRed,
  unfinishedValidation,
} from '../.archon/workflows/sdlc/.shared/verdict';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): { cwd: string; artifacts: string; request: CompositionRequest } {
  const root = track(mkdtempSync(join(tmpdir(), 'composition-proof-')));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(cwd, '.gitignore'), 'ignored-output\n');
  writeFileSync(join(cwd, 'value.txt'), 'value');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'original');
  const original = git(cwd, 'rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'consumer'), 'reads value.txt');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'consumer');
  const head = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'checkout', '--detach', original);
  renameSync(join(cwd, 'value.txt'), join(cwd, 'renamed.txt'));
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'move value');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const check = join(root, 'gate.js');
  writeFileSync(
    check,
    `const fs=require('node:fs'); if(fs.existsSync('consumer')) fs.readFileSync('value.txt');`
  );
  return {
    cwd,
    artifacts: join(root, 'artifacts'),
    request: {
      original_base: original,
      base,
      head,
      change: 'PR consumer',
      base_changes: ['PR move'],
      method: 'squash',
      check: { name: 'project gate', argv: [process.execPath, check], environment: 'local test' },
    },
  };
}

describe('three-tree project gate evidence', () => {
  it('proves interaction through disjoint files and retains exact command, trees and logs', async () => {
    const f = fixture();
    const before = git(f.cwd, 'status', '--porcelain');
    const result = await compareComposition(f.cwd, f.artifacts, f.request);
    expect(result.verdict.green).toBe(false);
    expect(result.verdict.red_cause).toBe('interaction');
    expect(result.verdict.summary).toContain('PR consumer');
    expect(result.verdict.summary).toContain('PR move');
    expect(result.verdict.summary).toContain('value.txt');
    expect(result.evidence.observations.map(o => o.exit_code)).toEqual([0, 0, 1]);
    for (const observation of result.evidence.observations) {
      expect(observation.subject.tree).toBe(
        git(f.cwd, 'rev-parse', `${observation.subject.commit}^{tree}`)
      );
      expect(observation.command).toEqual(f.request.check);
      expect(observation.git_clean_after).toBe(true);
    }
    expect(readFileSync(result.evidence.observations[2]!.log, 'utf8')).toContain('value.txt');
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toEqual(result.evidence);
    expect(git(f.cwd, 'status', '--porcelain')).toBe(before);
    expect(git(f.cwd, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(
      git(f.cwd, 'rev-list', '--parents', '-n', '1', result.evidence.candidate!.commit).split(' ')
    ).toHaveLength(2);

    const missing = structuredClone(result.evidence);
    missing.observations.shift();
    expect(comparisonVerdict(missing, result.path).red_cause).toBe('');
    const mismatch = structuredClone(result.evidence);
    mismatch.observations[0]!.check_digest = 'different check';
    expect(comparisonVerdict(mismatch, result.path).red_cause).toBe('');
    const relabeled = structuredClone(result.evidence);
    relabeled.observations[0]!.subject.commit = f.request.base;
    expect(comparisonVerdict(relabeled, result.path).red_cause).toBe('');

    expect(
      evidenceMatches(result.evidence, {
        repository: result.evidence.repository,
        request: f.request,
        candidate: result.evidence.candidate!,
      })
    ).toBe(true);
    for (const changed of [
      { ...f.request, base: f.request.original_base },
      { ...f.request, head: f.request.base },
      { ...f.request, base_changes: [] },
      { ...f.request, base_changes: ['other prefix'] },
      { ...f.request, method: 'merge' as const },
      { ...f.request, check: { ...f.request.check, environment: 'another environment' } },
    ])
      expect(
        evidenceMatches(result.evidence, {
          repository: result.evidence.repository,
          request: changed,
          candidate: result.evidence.candidate!,
        })
      ).toBe(false);
    expect(
      evidenceMatches(result.evidence, {
        repository: result.evidence.repository,
        request: f.request,
        candidate: { ...result.evidence.candidate!, commit: f.request.base },
      })
    ).toBe(false);
  });

  it('does not call an independently red change an interaction', async () => {
    const f = fixture();
    f.request.check.argv = [process.execPath, '-e', 'process.exit(1)'];
    const result = await compareComposition(f.cwd, f.artifacts, f.request);
    expect(result.verdict.red_cause).toBe('introduced');
    expect(result.verdict.green).toBe(false);
  });

  it('reports the composed gate green without borrowing separate red classifications', async () => {
    const f = fixture();
    f.request.check.argv = [process.execPath, '-e', 'process.exit(0)'];
    const result = await compareComposition(f.cwd, f.artifacts, f.request);
    expect(result.verdict.green).toBe(true);
    expect(result.verdict.red_cause).toBe('');
  });

  it('refuses a clean-tree verdict if the gate mutates a checkout, even with exit zero', async () => {
    const f = fixture();
    f.request.check.argv = [
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('new-file','dirty')",
    ];
    const result = await compareComposition(f.cwd, f.artifacts, f.request);
    expect(result.verdict.green).toBe(false);
    expect(result.verdict.red_cause).toBe('');
    expect(result.verdict.summary).toContain('changed a checkout');
  });

  it('permits ignored gate output without claiming it belongs to the Git tree', async () => {
    const f = fixture();
    f.request.check.argv = [
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('ignored-output','build')",
    ];
    const result = await compareComposition(f.cwd, f.artifacts, f.request);
    expect(result.verdict.green).toBe(true);
    expect(result.evidence.observations.every(o => o.git_clean_after)).toBe(true);
    expect(git(f.cwd, 'ls-tree', '-r', result.evidence.candidate!.tree)).not.toContain(
      'ignored-output'
    );
  });

  it('retains command diagnostics and revision identity when Git refuses composition', async () => {
    const f = fixture();
    git(f.cwd, 'checkout', '--orphan', 'unrelated');
    git(f.cwd, 'commit', '-qm', 'unrelated root');
    f.request.base = git(f.cwd, 'rev-parse', 'HEAD');
    await expect(compareComposition(f.cwd, f.artifacts, f.request)).rejects.toThrow('Evidence:');
    const evidence = JSON.parse(
      readFileSync(join(f.artifacts, readdirSync(f.artifacts)[0]!, 'evidence.json'), 'utf8')
    ) as CompositionEvidence;
    expect(evidence.request).toEqual(f.request);
    expect(evidence.composition!.exit_code).not.toBe(0);
    expect(evidence.composition!.exit_code).not.toBe(1);
    expect(readFileSync(evidence.composition!.stderr, 'utf8').length).toBeGreaterThan(0);
    expect(readFileSync(evidence.composition!.stdout, 'utf8')).toBe('');
    expect(evidence.observations).toEqual([]);
    expect(evidence.merge_bases).toBeNull();
  });

  it('retains a composition conflict without pretending three gates ran', async () => {
    const f = fixture();
    git(f.cwd, 'checkout', '--detach', f.request.original_base);
    writeFileSync(join(f.cwd, 'value.txt'), 'change one');
    git(f.cwd, 'add', '.');
    git(f.cwd, 'commit', '-qm', 'one');
    f.request.head = git(f.cwd, 'rev-parse', 'HEAD');
    git(f.cwd, 'checkout', '--detach', f.request.original_base);
    writeFileSync(join(f.cwd, 'value.txt'), 'change two');
    git(f.cwd, 'add', '.');
    git(f.cwd, 'commit', '-qm', 'two');
    f.request.base = git(f.cwd, 'rev-parse', 'HEAD');
    const result = await compareComposition(f.cwd, f.artifacts, f.request);
    expect(result.verdict.red_cause).toBe('');
    expect(result.evidence.observations).toEqual([]);
    expect(readFileSync(result.evidence.composition!.stdout, 'utf8')).toContain('value.txt');
  });

  it('rejects moving refs and abbreviated identities before execution', async () => {
    const f = fixture();
    await expect(
      compareComposition(f.cwd, f.artifacts, { ...f.request, head: 'HEAD' })
    ).rejects.toThrow('full Git object IDs');
    await expect(
      compareComposition(f.cwd, f.artifacts, { ...f.request, head: f.request.head.slice(0, 8) })
    ).rejects.toThrow('full commit IDs');
    expect(() =>
      parseCompositionRequest({ ...f.request, check: { ...f.request.check, argv: [] } })
    ).toThrow('project gate');
  });

  it('keeps interaction out of every shared accepted-red route', () => {
    expect(PASSES_RED).toEqual(['inherited', 'environment']);
    expect(passesRed('interaction')).toBe(false);
    expect(passesRed('')).toBe(false);
  });
});

it('equal predecessor trees do not preserve subsequent merge ancestry', () => {
  const f = fixture();
  git(f.cwd, 'checkout', '--detach', f.request.original_base);
  writeFileSync(join(f.cwd, 'value.txt'), 'A\n');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', 'A');
  const a = git(f.cwd, 'rev-parse', 'HEAD');
  writeFileSync(join(f.cwd, 'value.txt'), 'C\n');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', 'C stacked on A');
  const c = git(f.cwd, 'rev-parse', 'HEAD');
  const tree = git(f.cwd, 'rev-parse', `${a}^{tree}`);
  const merged = git(
    f.cwd,
    'commit-tree',
    tree,
    '-p',
    f.request.original_base,
    '-p',
    a,
    '-m',
    'merge A'
  );
  const squash = git(f.cwd, 'commit-tree', tree, '-p', f.request.original_base, '-m', 'squash A');
  expect(git(f.cwd, 'rev-parse', `${merged}^{tree}`)).toBe(
    git(f.cwd, 'rev-parse', `${squash}^{tree}`)
  );
  expect(
    Bun.spawnSync(['git', 'merge-tree', '--write-tree', merged, c], { cwd: f.cwd }).exitCode
  ).toBe(0);
  expect(
    Bun.spawnSync(['git', 'merge-tree', '--write-tree', squash, c], { cwd: f.cwd }).exitCode
  ).toBe(1);
});

it('keeps the validation producer schemas and script vocabulary in agreement', () => {
  type Workflow = {
    returns: string;
    nodes: {
      id: string;
      output_type?: string;
      output_format?: { properties: { red_cause: { enum: string[] } } };
    }[];
  };
  const root = join(import.meta.dir, '..', '.archon/workflows/sdlc');
  const validate = Bun.YAML.parse(
    readFileSync(join(root, 'validate/archon-validate.yaml'), 'utf8')
  ) as Workflow;
  const implement = Bun.YAML.parse(
    readFileSync(join(root, 'implement/archon-implement.yaml'), 'utf8')
  ) as Workflow;
  expect(
    validate.nodes.find(n => n.id === 'compare')!.output_format!.properties.red_cause.enum
  ).toEqual([...VALIDATION_RED_CAUSES]);
  expect(
    validate.nodes.find(n => n.id === 'result')!.output_format!.properties.red_cause.enum
  ).toEqual([...VALIDATION_RED_CAUSES]);
  expect(validate.nodes.filter(n => n.output_type === 'validation').map(n => n.id)).toEqual([
    validate.returns,
  ]);
  const ordinary = VALIDATION_RED_CAUSES.filter(cause => cause !== 'interaction');
  expect(
    validate.nodes.find(n => n.id === 'validate')!.output_format!.properties.red_cause.enum
  ).toEqual(ordinary);
  expect(
    implement.nodes.find(n => n.id === 'implement')!.output_format!.properties.red_cause.enum
  ).toEqual(ordinary);
});

it("refuses implement's unfinished validation with the green gates' message", () => {
  const script = join(
    import.meta.dir,
    '..',
    '.archon/workflows/sdlc/implement/scripts/assert-changed.ts'
  );
  const summary = 'A usage limit stopped validation during tests; type-check passed.';
  const run = Bun.spawnSync([process.execPath, script], {
    env: {
      ...process.env,
      INPUTS_GREEN: 'false',
      INPUTS_RED_CAUSE: 'incomplete',
      INPUTS_SUMMARY: summary,
      INPUTS_BASELINE: '',
    },
  });
  expect(run.exitCode).toBe(1);
  expect(run.stdout.toString()).toBe('');
  expect(run.stderr.toString().trim()).toBe(unfinishedValidation('The implementation', summary));
  expect(run.stderr.toString()).not.toMatch(/\bred\b/);
});

describe('the green gate on a validation that did not finish', () => {
  const script = join(
    import.meta.dir,
    '..',
    '.archon/workflows/sdlc/deliver/scripts/gate-green.ts'
  );
  function gate(cause: string, summary: string, green = 'false') {
    const run = Bun.spawnSync([process.execPath, script], {
      env: {
        ...process.env,
        INPUTS_GREEN: green,
        INPUTS_RED_CAUSE: cause,
        INPUTS_SUMMARY: summary,
        INPUTS_STAGE: 'The project gate',
      },
    });
    return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  }

  it('refuses incomplete as unfinished, never as red, and carries the reason', () => {
    const summary = 'A usage limit stopped validation during type-check; lint passed.';
    const result = gate('incomplete', summary);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("The project gate: validation didn't finish.");
    expect(result.stderr).toContain(summary);
    expect(result.stderr).toContain('Resume the run');
    expect(result.stderr).not.toMatch(/\bred\b/);
  });

  it('refuses incomplete even when the verdict also claims green', () => {
    const result = gate('incomplete', 'type-check never ran', 'true');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("validation didn't finish");
  });

  it('still refuses red with no declared cause as unexplained red', () => {
    const result = gate('', 'tests failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is red and declared no red_cause');
  });
});

it('forwards interaction through the CI projection without making it an accepted-red attention route', () => {
  const root = join(import.meta.dir, '..', '.archon/workflows/sdlc/deliver/scripts');
  const project = Bun.spawnSync([process.execPath, join(root, 'ci-round-result.ts')], {
    env: { ...process.env, INPUTS_RED_CAUSE: 'interaction', INPUTS_ACTION: 'none' },
  });
  expect(project.exitCode).toBe(0);
  expect(JSON.parse(project.stdout.toString())).toEqual({
    action: 'none',
    red_cause: 'interaction',
  });
  const route = Bun.spawnSync([process.execPath, join(root, 'ci-attention-route.ts')], {
    env: { ...process.env, INPUTS_RED_CAUSE: 'interaction' },
  });
  expect(route.exitCode).toBe(0);
  expect(JSON.parse(route.stdout.toString())).toEqual({
    attention: false,
    red_cause: 'interaction',
  });
});
