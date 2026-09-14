import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const workflowRoot = resolve(import.meta.dir, '../../../../.archon/workflows/sdlc');
const mergeScript = join(workflowRoot, 'merge-queue', 'scripts', 'merge-action.ts');
const captureScript = join(workflowRoot, 'verify-runtime', 'scripts', 'capture-command.ts');
const finishScript = join(workflowRoot, 'verify-runtime', 'scripts', 'finish-attempt.py');
const gateScript = join(workflowRoot, 'verify-runtime', 'scripts', 'gate-verified.py');
const checkScript = join(workflowRoot, 'verify-runtime', 'scripts', 'check-evidence.py');

let root: string;
let fakeBin: string;
let fakeGh: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-factory-workflows-'));
  fakeBin = join(root, 'bin');
  await mkdir(fakeBin);
  const source = join(root, 'fake-gh.ts');
  const fakeGhOutput = join(fakeBin, 'gh');
  fakeGh = process.platform === 'win32' ? `${fakeGhOutput}.exe` : fakeGhOutput;
  await writeFile(
    source,
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG!, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  if (process.env.GH_VIEW_MODE === 'failed') process.exit(1);
  if (process.env.GH_VIEW_MODE === 'malformed') {
    console.log('{');
    process.exit(0);
  }
  console.log(JSON.stringify({state:'MERGED', mergedAt:'2026-09-14T00:00:00Z', mergeCommit:{oid:'abc'}, url:'https://example.test/pr/1'}));
}
if (args[0] === 'api') console.log(process.env.GH_BASE_SHA ?? 'base-after-merge');
`
  );
  const built = Bun.spawnSync(['bun', 'build', source, '--compile', '--outfile', fakeGhOutput], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  if (process.platform !== 'win32') await chmod(fakeGh, 0o755);
});

afterAll(async () => {
  await removeTempTree(root);
});

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function run(
  script: string,
  env: Record<string, string>,
  args: string[] = []
): ReturnType<typeof Bun.spawnSync> {
  const childEnv = { ...process.env, ...env };
  if (process.platform === 'win32' && env.PATH !== undefined) {
    for (const key of Object.keys(childEnv)) {
      if (key.toLowerCase() === 'path') delete childEnv[key];
    }
    childEnv.Path = env.PATH;
  }
  return Bun.spawnSync([process.execPath, script, ...args], {
    cwd: fakeBin,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function stdout(result: ReturnType<typeof Bun.spawnSync>): string {
  return result.stdout?.toString() ?? '';
}

async function mergeFixture(method = 'squash'): Promise<{
  artifacts: string;
  content: string;
  plan: Record<string, unknown>;
}> {
  const artifacts = await mkdtemp(join(root, 'merge-'));
  const evidencePath = join(artifacts, 'review.md');
  const evidenceContent = 'reviewed evidence\n';
  await writeFile(evidencePath, evidenceContent);
  const plan = {
    repository: 'owner/repo',
    base: 'dev',
    base_sha: 'base',
    method,
    pull_requests: [
      { number: 17, url: 'https://github.test/owner/repo/pull/17', head_sha: 'head-17' },
    ],
    evidence: [{ path: evidencePath, sha256: digest(evidenceContent) }],
  };
  const content = `${JSON.stringify(plan)}\n`;
  await writeFile(join(artifacts, 'merge-plan.json'), content);
  return { artifacts, content, plan };
}

function assessment(
  content: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    summary: 'eligible',
    eligible: true,
    method: 'squash',
    ci_requirement: 'none',
    checks_state: 'not_applicable',
    validation_verified: true,
    review_verified: true,
    plan_digest: digest(content),
    ...overrides,
  };
}

describe('merge action boundary', () => {
  test('distinguishes known no-CI from unknown or failing required CI', async () => {
    const { artifacts, content } = await mergeFixture();
    const invoke = (overrides: Record<string, unknown>) => {
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'gate',
        INPUTS_ASSESSMENT: JSON.stringify(assessment(content, overrides)),
        INPUTS_MERGE_METHOD: 'squash',
      });
      expect(result.exitCode).toBe(0);
      return JSON.parse(stdout(result)) as Record<string, unknown>;
    };

    expect(invoke({})).toMatchObject({ ready: true, method: 'squash' });
    expect(invoke({ ci_requirement: 'unknown', checks_state: 'missing' })).toMatchObject({
      ready: false,
      summary: expect.stringContaining('required CI policy is unknown'),
    });
    expect(invoke({ ci_requirement: 'required', checks_state: 'failing' })).toMatchObject({
      ready: false,
      summary: expect.stringContaining('required checks are not passing'),
    });
    expect(invoke({ method: '' })).toMatchObject({
      ready: false,
      summary: expect.stringContaining('merge method is missing'),
    });
    expect(invoke({ method: 'rebase' })).toMatchObject({
      ready: false,
      summary: expect.stringContaining('merge method is missing'),
    });
    expect(invoke({ eligible: false })).toMatchObject({
      ready: false,
      summary: expect.stringContaining('assessed batch is not eligible'),
    });
  });

  test('holds an invalid plan, changed evidence, and explicit method mismatch at the gate', async () => {
    const invalid = await mergeFixture();
    delete invalid.plan.pull_requests;
    const invalidContent = `${JSON.stringify(invalid.plan)}\n`;
    await writeFile(join(invalid.artifacts, 'merge-plan.json'), invalidContent);
    const invalidResult = run(mergeScript, {
      ARTIFACTS_DIR: invalid.artifacts,
      INPUTS_ACTION: 'gate',
      INPUTS_ASSESSMENT: JSON.stringify(assessment(invalidContent)),
      INPUTS_MERGE_METHOD: 'squash',
    });
    expect(JSON.parse(stdout(invalidResult))).toMatchObject({
      ready: false,
      summary: expect.stringContaining('plan entries are missing or invalid'),
    });

    const changed = await mergeFixture();
    const evidence = (changed.plan.evidence as Array<{ path: string }>)[0];
    await writeFile(evidence.path, 'changed evidence\n');
    const changedResult = run(mergeScript, {
      ARTIFACTS_DIR: changed.artifacts,
      INPUTS_ACTION: 'gate',
      INPUTS_ASSESSMENT: JSON.stringify(assessment(changed.content)),
      INPUTS_MERGE_METHOD: 'squash',
    });
    expect(JSON.parse(stdout(changedResult))).toMatchObject({
      ready: false,
      summary: expect.stringContaining('approved evidence changed'),
    });

    const missing = await mergeFixture();
    const missingEvidence = (missing.plan.evidence as Array<{ path: string }>)[0];
    await unlink(missingEvidence.path);
    const missingResult = run(mergeScript, {
      ARTIFACTS_DIR: missing.artifacts,
      INPUTS_ACTION: 'gate',
      INPUTS_ASSESSMENT: JSON.stringify(assessment(missing.content)),
      INPUTS_MERGE_METHOD: 'squash',
    });
    expect(JSON.parse(stdout(missingResult))).toMatchObject({
      ready: false,
      summary: expect.stringContaining('approved evidence is unavailable'),
    });

    const mismatch = await mergeFixture();
    const mismatchResult = run(mergeScript, {
      ARTIFACTS_DIR: mismatch.artifacts,
      INPUTS_ACTION: 'gate',
      INPUTS_ASSESSMENT: JSON.stringify(assessment(mismatch.content)),
      INPUTS_MERGE_METHOD: 'rebase',
    });
    expect(JSON.parse(stdout(mismatchResult))).toMatchObject({
      ready: false,
      summary: expect.stringContaining('requested merge method does not match'),
    });
  });

  test('holds missing, conflicting, and changed approvals without invoking gh', async () => {
    const { artifacts, content } = await mergeFixture();
    const gate = assessment(content);
    for (const [index, changed] of [
      { gate: { ...gate, ready: false }, mode: 'auto', approval: null },
      { gate: { ...gate, ready: true }, mode: 'approve', approval: { decision: 'hold' } },
      { gate: { ...gate, ready: true }, mode: 'approve', approval: null },
    ].entries()) {
      const ghLog = join(artifacts, `unauthorized-${index}.jsonl`);
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'execute',
        INPUTS_GATE: JSON.stringify(changed.gate),
        INPUTS_MODE: changed.mode,
        INPUTS_APPROVAL: JSON.stringify(changed.approval),
        INPUTS_REQUEST: JSON.stringify({
          authorized: true,
          repository: 'owner/repo',
          number: 17,
          head_sha: 'head-17',
          method: 'squash',
          summary: 'fresh facts pass',
        }),
        INPUTS_PREVIOUS: '',
        INPUTS_MERGE_METHOD: 'squash',
        GH_LOG: ghLog,
        PATH: fakeBin,
      });
      expect(JSON.parse(stdout(result))).toMatchObject({
        done: true,
        merged: false,
        summary: 'merge is not authorized',
      });
      expect(await Bun.file(ghLog).exists()).toBe(false);
    }

    const approvedGate = { ...gate, ready: true };
    await writeFile(join(artifacts, 'merge-plan.json'), `${content} `);
    const changedPlan = run(mergeScript, {
      ARTIFACTS_DIR: artifacts,
      INPUTS_ACTION: 'execute',
      INPUTS_GATE: JSON.stringify(approvedGate),
      INPUTS_MODE: 'auto',
      INPUTS_APPROVAL: '',
      INPUTS_REQUEST: '{}',
      INPUTS_PREVIOUS: '',
      INPUTS_MERGE_METHOD: 'squash',
      PATH: fakeBin,
    });
    expect(JSON.parse(stdout(changedPlan))).toMatchObject({
      merged: false,
      summary: 'approved merge plan changed',
    });
  });

  test('uses the exact approved method and binds the head for every write', async () => {
    for (const [method, flag] of [
      ['merge', '--merge'],
      ['squash', '--squash'],
      ['rebase', '--rebase'],
    ] as const) {
      const { artifacts, content } = await mergeFixture(method);
      const ghLog = join(artifacts, 'gh.jsonl');
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'execute',
        INPUTS_GATE: JSON.stringify({ ...assessment(content, { method }), ready: true }),
        INPUTS_MODE: 'auto',
        INPUTS_APPROVAL: '',
        INPUTS_REQUEST: JSON.stringify({
          authorized: true,
          repository: 'owner/repo',
          number: 17,
          head_sha: 'head-17',
          method,
          summary: 'fresh facts pass',
        }),
        INPUTS_PREVIOUS: '',
        INPUTS_MERGE_METHOD: method,
        GH_LOG: ghLog,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(stdout(result))).toMatchObject({
        merged: true,
        prior_base_sha: 'base-after-merge',
      });
      const calls = (await readFile(ghLog, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(calls[0]).toEqual([
        'pr',
        'merge',
        '17',
        '--repo',
        'owner/repo',
        flag,
        '--match-head-commit',
        'head-17',
      ]);
      expect(calls[2]).toEqual(['api', 'repos/owner/repo/branches/dev', '--jq', '.commit.sha']);
    }
  });

  test('rechecks evidence and requested method before an authorized write', async () => {
    for (const failure of ['evidence', 'method'] as const) {
      const { artifacts, content, plan } = await mergeFixture();
      const ghLog = join(artifacts, `${failure}.jsonl`);
      if (failure === 'evidence') {
        const evidence = (plan.evidence as Array<{ path: string }>)[0];
        await writeFile(evidence.path, 'mutated after approval\n');
      }
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'execute',
        INPUTS_GATE: JSON.stringify({ ...assessment(content), ready: true }),
        INPUTS_MODE: 'auto',
        INPUTS_APPROVAL: '',
        INPUTS_REQUEST: JSON.stringify({
          authorized: true,
          repository: 'owner/repo',
          number: 17,
          head_sha: 'head-17',
          method: 'squash',
          summary: 'fresh facts pass',
        }),
        INPUTS_PREVIOUS: '',
        INPUTS_MERGE_METHOD: failure === 'method' ? 'rebase' : 'squash',
        GH_LOG: ghLog,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      });
      expect(JSON.parse(stdout(result))).toMatchObject({ done: true, merged: false });
      expect(await Bun.file(ghLog).exists()).toBe(false);
    }
  });

  test('returns the live base between PRs and preserves it through the next iteration', async () => {
    const fixture = await mergeFixture();
    (fixture.plan.pull_requests as Array<Record<string, unknown>>).push({
      number: 18,
      url: 'https://github.test/owner/repo/pull/18',
      head_sha: 'head-18',
    });
    const content = `${JSON.stringify(fixture.plan)}\n`;
    await writeFile(join(fixture.artifacts, 'merge-plan.json'), content);
    const execute = (request: Record<string, unknown>, previous: unknown, baseSha: string) =>
      run(mergeScript, {
        ARTIFACTS_DIR: fixture.artifacts,
        INPUTS_ACTION: 'execute',
        INPUTS_GATE: JSON.stringify({ ...assessment(content), ready: true }),
        INPUTS_MODE: 'auto',
        INPUTS_APPROVAL: '',
        INPUTS_REQUEST: JSON.stringify(request),
        INPUTS_PREVIOUS: previous === null ? '' : JSON.stringify(previous),
        INPUTS_MERGE_METHOD: 'squash',
        GH_BASE_SHA: baseSha,
        GH_LOG: join(fixture.artifacts, 'continuity.jsonl'),
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      });
    const first = JSON.parse(
      stdout(
        execute(
          {
            authorized: true,
            repository: 'owner/repo',
            number: 17,
            head_sha: 'head-17',
            method: 'squash',
          },
          null,
          'base-after-17'
        )
      )
    ) as Record<string, unknown>;
    expect(first).toMatchObject({
      done: false,
      urls: ['https://github.test/owner/repo/pull/17'],
      prior_base_sha: 'base-after-17',
    });
    const second = JSON.parse(
      stdout(
        execute(
          {
            authorized: true,
            repository: 'owner/repo',
            number: 18,
            head_sha: 'head-18',
            method: 'squash',
          },
          first,
          'base-after-18'
        )
      )
    );
    expect(second).toMatchObject({
      done: true,
      merged: true,
      prior_base_sha: 'base-after-18',
    });
  });

  test('holds failed or malformed GitHub readback as unclear, not queued', async () => {
    for (const mode of ['failed', 'malformed']) {
      const { artifacts, content } = await mergeFixture();
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'execute',
        INPUTS_GATE: JSON.stringify({ ...assessment(content), ready: true }),
        INPUTS_MODE: 'auto',
        INPUTS_APPROVAL: '',
        INPUTS_REQUEST: JSON.stringify({
          authorized: true,
          repository: 'owner/repo',
          number: 17,
          head_sha: 'head-17',
          method: 'squash',
        }),
        INPUTS_PREVIOUS: '',
        INPUTS_MERGE_METHOD: 'squash',
        GH_VIEW_MODE: mode,
        GH_LOG: join(artifacts, `${mode}.jsonl`),
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      });
      expect(JSON.parse(stdout(result))).toMatchObject({
        done: true,
        merged: false,
        queued: [],
        summary: expect.stringContaining('state is unclear'),
      });
    }
  });
});

describe('runtime evidence handoff', () => {
  test('captures literal stdout, stderr, and a negative exit status', async () => {
    const directory = await mkdtemp(join(root, 'capture-'));
    const prefix = join(directory, 'negative');
    const result = run(captureScript, {}, [
      prefix,
      '--',
      'bun',
      '-e',
      "process.stdout.write('literal false\\n'); process.stderr.write('failed detail\\n'); process.exit(7)",
    ]);
    expect(result.exitCode).toBe(7);
    expect(await readFile(`${prefix}.stdout`, 'utf8')).toBe('literal false\n');
    expect(await readFile(`${prefix}.stderr`, 'utf8')).toBe('failed detail\n');
    expect(JSON.parse(await readFile(`${prefix}.exit.json`, 'utf8'))).toEqual({ exit_code: 7 });
  });

  test('returns the exact attempt directory and report path through the terminal gate', async () => {
    const directory = await mkdtemp(join(root, 'attempt-'));
    const reportPath = join(directory, 'report.json');
    const finish = Bun.spawnSync(['uv', 'run', '--no-project', finishScript], {
      env: {
        ...process.env,
        INPUTS_ASSESSMENT: JSON.stringify({
          status: 'verified',
          reason: 'passed',
          candidate: 'head',
        }),
        INPUTS_TEARDOWN_OK: 'true',
        INPUTS_ATTEMPT: '1',
        INPUTS_ATTEMPT_LIMIT: '2',
        INPUTS_CHECKOUT: 'checkout',
        INPUTS_DIRECTORY: directory,
        INPUTS_REPORT_PATH: reportPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(finish.exitCode).toBe(0);
    const finished = JSON.parse(finish.stdout.toString()) as Record<string, unknown>;
    expect(finished).toMatchObject({ directory, report_path: reportPath });

    const gate = Bun.spawnSync(['uv', 'run', '--no-project', gateScript], {
      env: {
        ...process.env,
        INPUTS_STATUS: String(finished.status),
        INPUTS_REASON: String(finished.reason),
        INPUTS_CANDIDATE: String(finished.candidate),
        INPUTS_CHECKOUT: String(finished.checkout),
        INPUTS_DIRECTORY: String(finished.directory),
        INPUTS_REPORT_PATH: String(finished.report_path),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(JSON.parse(gate.stdout.toString())).toMatchObject({
      directory,
      report_path: reportPath,
    });
  });

  test('rejects missing evidence instead of substituting the report assertion', async () => {
    const directory = await mkdtemp(join(root, 'missing-evidence-'));
    const reportPath = join(directory, 'report.json');
    await writeFile(join(directory, 'target.txt'), 'head\n');
    await writeFile(
      reportPath,
      JSON.stringify({
        candidate: 'head',
        assertions: [
          {
            id: 'healthy',
            outcome: 'passed',
            expected: true,
            observed: true,
            reason: 'claimed pass',
            evidence_path: 'missing.stdout',
          },
        ],
      })
    );
    const checked = Bun.spawnSync(['uv', 'run', '--no-project', checkScript], {
      env: {
        ...process.env,
        INPUTS_START_OK: 'true',
        INPUTS_IDENTITY_OK: 'true',
        INPUTS_DIRECTORY: directory,
        INPUTS_REPORT_PATH: reportPath,
        INPUTS_REQUIRED_IDS: JSON.stringify(['healthy']),
        INPUTS_EXPECTED_CANDIDATE: 'head',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(JSON.parse(checked.stdout.toString())).toMatchObject({
      status: 'malformed',
      reason: expect.stringContaining('evidence is missing or empty'),
    });
  });

  test('accepts an opaque target identity when no explicit target candidate is supplied', async () => {
    const directory = await mkdtemp(join(root, 'opaque-identity-'));
    const reportPath = join(directory, 'report.json');
    const target = 'factory-v1:0123456789abcdef';
    await writeFile(join(directory, 'target.txt'), `${target}\n`);
    await writeFile(join(directory, 'healthy.stdout'), '{"source_revision":"git-head"}\n');
    await writeFile(
      reportPath,
      JSON.stringify({
        candidate: target,
        assertions: [
          {
            id: 'healthy',
            outcome: 'passed',
            expected: true,
            observed: { source_revision: 'git-head' },
            reason: 'source revision matches',
            evidence_path: 'healthy.stdout',
          },
        ],
      })
    );
    const checked = Bun.spawnSync(['uv', 'run', '--no-project', checkScript], {
      env: {
        ...process.env,
        INPUTS_START_OK: 'true',
        INPUTS_IDENTITY_OK: 'true',
        INPUTS_DIRECTORY: directory,
        INPUTS_REPORT_PATH: reportPath,
        INPUTS_REQUIRED_IDS: JSON.stringify(['healthy']),
        INPUTS_EXPECTED_CANDIDATE: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(JSON.parse(checked.stdout.toString())).toMatchObject({
      status: 'verified',
      candidate: target,
    });
  });
});
