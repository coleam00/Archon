import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

// These tests spawn the real scripts and a compiled fake gh, several per case; under
// parallel load that exceeds bun's 5 s per-test default. Applies to this file.
setDefaultTimeout(60_000);

const workflowRoot = resolve(import.meta.dir, '../../../../.archon/workflows/sdlc');
const mergeScript = join(workflowRoot, 'merge-queue', 'scripts', 'merge-action.ts');
const ciPolicyScript = join(workflowRoot, 'merge-queue', 'scripts', 'ci-policy.ts');
const pathPolicyScript = join(workflowRoot, 'merge-queue', 'scripts', 'path-policy.ts');
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
    `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG!, JSON.stringify(args) + '\\n');
if (process.env.GH_FIXTURE) {
  // Longest argument-prefix match wins; an unmatched call fails like an API error.
  const responses = JSON.parse(readFileSync(process.env.GH_FIXTURE, 'utf8'));
  const call = args.join(' ');
  const key = Object.keys(responses)
    .filter(prefix => call.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  if (key === undefined) process.exit(1);
  process.stdout.write(responses[key].stdout ?? '');
  process.exit(responses[key].exit ?? 0);
}
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
    validation_verified: true,
    review_verified: true,
    plan_digest: digest(content),
    ...overrides,
  };
}

describe('merge action boundary', () => {
  test('gates on the scripted CI policy, never on an agent claim about CI', async () => {
    const { artifacts, content } = await mergeFixture();
    const none = { requirement: 'none', checks_state: 'not_applicable', reason: '' };
    const invoke = (overrides: Record<string, unknown>, policy: unknown = none) => {
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'gate',
        INPUTS_ASSESSMENT: JSON.stringify(assessment(content, overrides)),
        INPUTS_CI_POLICY: policy === null ? '' : JSON.stringify(policy),
        INPUTS_MERGE_METHOD: 'squash',
      });
      expect(result.exitCode).toBe(0);
      return JSON.parse(stdout(result)) as Record<string, unknown>;
    };

    expect(invoke({})).toMatchObject({ ready: true, method: 'squash' });
    // An agent's own CI fields no longer decide anything: on identical evidence
    // the model answered "none" and "unknown" by turns.
    expect(invoke({ ci_requirement: 'unknown', checks_state: 'missing' })).toMatchObject({
      ready: true,
    });
    expect(
      invoke({}, { requirement: 'required', checks_state: 'passing', reason: '' })
    ).toMatchObject({ ready: true });
    expect(
      invoke(
        {},
        { requirement: 'unknown', checks_state: 'unknown', reason: 'declare required_checks' }
      )
    ).toMatchObject({
      ready: false,
      summary: expect.stringContaining('required CI policy is unknown: declare required_checks'),
    });
    expect(invoke({}, null)).toMatchObject({
      ready: false,
      summary: expect.stringContaining('required CI policy is unknown'),
    });
    for (const state of ['failing', 'pending', 'missing', 'unknown']) {
      expect(
        invoke({}, { requirement: 'required', checks_state: state, reason: `tests is ${state}` })
      ).toMatchObject({
        ready: false,
        summary: expect.stringContaining(`required checks are not passing: tests is ${state}`),
      });
    }
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

  test('a Git Bash drive path to evidence is read on Windows and sealed as a native path', async () => {
    if (process.platform !== 'win32') return;
    const fixture = await mergeFixture();
    const evidence = (fixture.plan.evidence as Array<{ path: string }>)[0];
    // Seen live: the assess agent wrote /c/Users/... and a verified PR was held as
    // "approved evidence is unavailable".
    const bash = evidence.path
      .replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`)
      .replace(/\\/g, '/');
    fixture.plan.evidence = [{ path: bash, sha256: '0'.repeat(64) }];
    const content = `${JSON.stringify(fixture.plan)}\n`;
    await writeFile(join(fixture.artifacts, 'merge-plan.json'), content);
    const result = run(mergeScript, {
      ARTIFACTS_DIR: fixture.artifacts,
      INPUTS_ACTION: 'gate',
      INPUTS_ASSESSMENT: JSON.stringify(assessment(content)),
      INPUTS_CI_POLICY: JSON.stringify({ requirement: 'none', checks_state: 'not_applicable' }),
      INPUTS_MERGE_METHOD: 'squash',
    });
    expect(JSON.parse(stdout(result))).toMatchObject({ ready: true });
    const sealed = JSON.parse(
      await readFile(join(fixture.artifacts, 'merge-plan.json'), 'utf8')
    ) as {
      evidence: Array<{ path: string }>;
    };
    expect(sealed.evidence[0].path).toMatch(/^[A-Z]:\//);
  });

  test('the gate seals the plan itself; an agent digest, empty or miscopied, decides nothing', async () => {
    const { artifacts, content } = await mergeFixture();
    const real = digest(content);
    // Seen live: the agent returned this digest with two characters miscopied.
    const miscopied = `${real.slice(0, 28)}d${real.slice(28, 40)}${real[41] === 'd' ? 'c' : 'd'}${real.slice(42, 63)}`;
    for (const claimed of ['', miscopied, real]) {
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'gate',
        INPUTS_ASSESSMENT: JSON.stringify(assessment(content, { plan_digest: claimed })),
        INPUTS_CI_POLICY: JSON.stringify({ requirement: 'none', checks_state: 'not_applicable' }),
        INPUTS_PATH_POLICY: JSON.stringify({ state: 'not_applicable' }),
        INPUTS_MERGE_METHOD: 'squash',
      });
      expect(JSON.parse(stdout(result))).toMatchObject({ ready: true, plan_digest: real });
    }
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

    // The gate seals evidence itself: a stale or miscopied agent hash decides nothing,
    // and the sealed plan carries the file's real hash for execution to recheck.
    const changed = await mergeFixture();
    const evidence = (changed.plan.evidence as Array<{ path: string }>)[0];
    await writeFile(evidence.path, 'changed evidence\n');
    const changedResult = run(mergeScript, {
      ARTIFACTS_DIR: changed.artifacts,
      INPUTS_ACTION: 'gate',
      INPUTS_ASSESSMENT: JSON.stringify(assessment(changed.content)),
      INPUTS_CI_POLICY: JSON.stringify({ requirement: 'none', checks_state: 'not_applicable' }),
      INPUTS_MERGE_METHOD: 'squash',
    });
    const sealedBytes = await readFile(join(changed.artifacts, 'merge-plan.json'), 'utf8');
    expect(JSON.parse(stdout(changedResult))).toMatchObject({
      ready: true,
      plan_digest: digest(sealedBytes),
    });
    expect(
      (JSON.parse(sealedBytes) as { evidence: Array<{ sha256: string }> }).evidence[0].sha256
    ).toBe(digest('changed evidence\n'));

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

  test('allows an authorized GitHub-only plan with empty evidence', async () => {
    const fixture = await mergeFixture();
    fixture.plan.evidence = [];
    const content = `${JSON.stringify(fixture.plan)}\n`;
    await writeFile(join(fixture.artifacts, 'merge-plan.json'), content);
    const ghLog = join(fixture.artifacts, 'gh.jsonl');
    const result = run(mergeScript, {
      ARTIFACTS_DIR: fixture.artifacts,
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
        summary: 'fresh GitHub facts pass',
      }),
      INPUTS_PREVIOUS: '',
      INPUTS_MERGE_METHOD: 'squash',
      GH_LOG: ghLog,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout(result))).toMatchObject({ merged: true });
    expect(await Bun.file(ghLog).exists()).toBe(true);
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

describe('required-check policy script', () => {
  const pr = 'https://github.test/owner/repo/pull/17';
  const head = 'head-17';
  const http = (status: number, body: unknown) =>
    `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
  const forbidden = http(403, { message: 'Upgrade to GitHub Pro', status: '403' });
  const unprotected = http(200, {
    name: 'main',
    protected: false,
    protection: {
      enabled: false,
      required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] },
    },
  });
  const lines = (items: unknown[]) => items.map(item => JSON.stringify(item)).join('\n') + '\n';

  async function policy(
    requiredChecks: string,
    responses: Record<string, { stdout?: string; exit?: number }>
  ): Promise<Record<string, unknown>> {
    const dir = await mkdtemp(join(root, 'ci-policy-'));
    const fixture = join(dir, 'gh.json');
    await writeFile(
      fixture,
      JSON.stringify({
        'pr view 17 --repo owner/repo': {
          stdout: JSON.stringify({ baseRefName: 'main', headRefOid: head }),
        },
        ...responses,
      })
    );
    const result = run(ciPolicyScript, {
      INPUTS_PRS: JSON.stringify([pr]),
      INPUTS_REQUIRED_CHECKS: requiredChecks,
      GH_FIXTURE: fixture,
      GH_LOG: join(dir, 'gh.jsonl'),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(stdout(result)) as Record<string, unknown>;
  }

  const freePrivate = {
    'api --include repos/owner/repo/branches/main': { stdout: unprotected, exit: 0 },
    'api --include repos/owner/repo/rules/branches/main': { stdout: forbidden, exit: 1 },
  };
  const checks = (runs: unknown[], statuses: unknown[] = []) => ({
    [`api --paginate repos/owner/repo/commits/${head}/check-runs`]: { stdout: lines(runs) },
    [`api --paginate repos/owner/repo/commits/${head}/statuses`]: { stdout: lines(statuses) },
  });

  test('an undeclared policy GitHub will not report is unknown, never none', async () => {
    const result = await policy('', freePrivate);
    expect(result).toMatchObject({ requirement: 'unknown', checks_state: 'unknown' });
    expect(result.reason).toContain('rulesets (HTTP 403)');
    expect(result.reason).toContain('required_checks');
  });

  test('a declared policy decides when GitHub cannot report one', async () => {
    expect(await policy('none', freePrivate)).toMatchObject({
      requirement: 'none',
      source: 'declared',
      checks_state: 'not_applicable',
    });
    const passing = { id: 2, name: 'tests', status: 'completed', conclusion: 'success' };
    expect(await policy('tests', { ...freePrivate, ...checks([passing]) })).toMatchObject({
      requirement: 'required',
      source: 'declared',
      checks: ['tests'],
      checks_state: 'passing',
    });
  });

  test('reads each required check result at the pull request head', async () => {
    const cases: Array<[unknown[], unknown[], string]> = [
      [[{ id: 1, name: 'tests', status: 'in_progress', conclusion: null }], [], 'pending'],
      [[{ id: 1, name: 'tests', status: 'completed', conclusion: 'failure' }], [], 'failing'],
      [[{ id: 1, name: 'lint', status: 'completed', conclusion: 'success' }], [], 'missing'],
      [[], [{ context: 'tests', state: 'success' }], 'passing'],
      [[], [{ context: 'tests', state: 'pending' }], 'pending'],
      // A rerun supersedes the earlier failure.
      [
        [
          { id: 1, name: 'tests', status: 'completed', conclusion: 'failure' },
          { id: 2, name: 'tests', status: 'completed', conclusion: 'success' },
        ],
        [],
        'passing',
      ],
    ];
    for (const [runs, statuses, state] of cases) {
      expect(await policy('tests', { ...freePrivate, ...checks(runs, statuses) })).toMatchObject({
        requirement: 'required',
        checks_state: state,
      });
    }
  });

  test('reads protection and rulesets when GitHub reports them', async () => {
    const noRules = {
      'api --include repos/owner/repo/rules/branches/main': { stdout: http(200, []) },
    };
    expect(
      await policy('', {
        'api --include repos/owner/repo/branches/main': { stdout: unprotected },
        ...noRules,
      })
    ).toMatchObject({ requirement: 'none', source: 'github' });

    const protectedBranch = http(200, {
      protected: true,
      protection: {
        enabled: true,
        required_status_checks: { contexts: ['tests'], checks: [{ context: 'tests' }] },
      },
    });
    const passing = checks([{ id: 1, name: 'tests', status: 'completed', conclusion: 'success' }]);
    expect(
      await policy('', {
        'api --include repos/owner/repo/branches/main': { stdout: protectedBranch },
        ...noRules,
        ...passing,
      })
    ).toMatchObject({ requirement: 'required', source: 'github', checks: ['tests'] });

    const ruleset = http(200, [
      { type: 'pull_request' },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'tests' }] },
      },
    ]);
    expect(
      await policy('', {
        'api --include repos/owner/repo/branches/main': { stdout: unprotected },
        'api --include repos/owner/repo/rules/branches/main': { stdout: ruleset },
        ...passing,
      })
    ).toMatchObject({ requirement: 'required', checks: ['tests'], checks_state: 'passing' });

    // A declaration never removes a check GitHub enforces.
    expect(
      await policy('none', {
        'api --include repos/owner/repo/branches/main': { stdout: protectedBranch },
        ...noRules,
        ...passing,
      })
    ).toMatchObject({ requirement: 'required', checks: ['tests'] });
  });

  async function batch(
    prs: string[],
    requiredChecks: string,
    responses: Record<string, { stdout?: string; exit?: number }>
  ): Promise<Record<string, unknown>> {
    const dir = await mkdtemp(join(root, 'ci-batch-'));
    const fixture = join(dir, 'gh.json');
    await writeFile(fixture, JSON.stringify(responses));
    const result = run(ciPolicyScript, {
      INPUTS_PRS: JSON.stringify(prs),
      INPUTS_REQUIRED_CHECKS: requiredChecks,
      GH_FIXTURE: fixture,
      GH_LOG: join(dir, 'gh.jsonl'),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(stdout(result)) as Record<string, unknown>;
  }
  const view = (base: string, sha: string) => ({
    stdout: JSON.stringify({ baseRefName: base, headRefOid: sha }),
  });
  const runsAt = (sha: string, conclusion: string) => ({
    [`api --paginate repos/owner/repo/commits/${sha}/check-runs`]: {
      stdout: lines([{ id: 1, name: 'tests', status: 'completed', conclusion }]),
    },
    [`api --paginate repos/owner/repo/commits/${sha}/statuses`]: { stdout: '' },
  });

  test('checks every pull request in a batch and names the one that fails', async () => {
    const result = await batch(
      ['https://github.test/owner/repo/pull/17', 'https://github.test/owner/repo/pull/18'],
      'tests',
      {
        'pr view 17 --repo owner/repo': view('main', 'a17'),
        'pr view 18 --repo owner/repo': view('main', 'a18'),
        ...freePrivate,
        ...runsAt('a17', 'success'),
        ...runsAt('a18', 'timed_out'),
      }
    );
    expect(result).toMatchObject({ requirement: 'required', checks_state: 'failing' });
    expect(result.reason).toBe('tests is failing on https://github.test/owner/repo/pull/18');
  });

  test('a batch across bases or repositories, or malformed input, is unknown', async () => {
    expect(
      await batch(
        ['https://github.test/owner/repo/pull/17', 'https://github.test/owner/repo/pull/18'],
        'none',
        {
          'pr view 17 --repo owner/repo': view('main', 'a17'),
          'pr view 18 --repo owner/repo': view('dev', 'a18'),
        }
      )
    ).toMatchObject({
      requirement: 'unknown',
      reason: expect.stringContaining('more than one base'),
    });
    expect(
      await batch(
        ['https://github.test/owner/repo/pull/17', 'https://github.test/other/repo/pull/18'],
        'none',
        {}
      )
    ).toMatchObject({
      requirement: 'unknown',
      reason: expect.stringContaining('more than one repository'),
    });
    for (const prs of [[], ['not a url'], ['https://github.test/owner/repo/issues/17']]) {
      expect(await batch(prs, 'none', {})).toMatchObject({ requirement: 'unknown' });
    }
    // An unreadable pull request never becomes a policy answer.
    expect(await batch(['https://github.test/owner/repo/pull/17'], 'none', {})).toMatchObject({
      requirement: 'unknown',
      reason: expect.stringContaining('could not read pull request'),
    });
  });

  test('every non-success conclusion or status fails, and a failed branch read is unknown', async () => {
    for (const conclusion of [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'startup_failure',
      'stale',
    ]) {
      expect(await policy('tests', { ...freePrivate, ...runsAt(head, conclusion) })).toMatchObject({
        checks_state: 'failing',
      });
    }
    for (const state of ['failure', 'error']) {
      expect(
        await policy('tests', { ...freePrivate, ...checks([], [{ context: 'tests', state }]) })
      ).toMatchObject({ checks_state: 'failing' });
    }
    // The branch read itself fails (no HTTP status at all) and nothing is declared.
    expect(
      await policy('', {
        'api --include repos/owner/repo/rules/branches/main': { stdout: http(200, []) },
      })
    ).toMatchObject({
      requirement: 'unknown',
      reason: expect.stringContaining('branch protection'),
    });
  });

  test('reads check results from the pull request rollup when REST check endpoints fail', async () => {
    const withRollup = (rollup: unknown[]) => ({
      'pr view 17 --repo owner/repo': {
        stdout: JSON.stringify({
          baseRefName: 'main',
          headRefOid: head,
          statusCheckRollup: rollup,
        }),
      },
      ...freePrivate,
      // Seen live: GitHub answered HTTP 500 for these on a head whose rollup was fine.
      [`api --paginate repos/owner/repo/commits/${head}/check-runs`]: { stdout: '', exit: 1 },
      [`api --paginate repos/owner/repo/commits/${head}/statuses`]: { stdout: '', exit: 1 },
    });
    const run = (status: string, conclusion: string, startedAt = '2026-10-07T14:00:00Z') => ({
      __typename: 'CheckRun',
      name: 'tests',
      status,
      conclusion,
      startedAt,
    });
    const cases: Array<[unknown[], string]> = [
      [[run('COMPLETED', 'SUCCESS')], 'passing'],
      [[run('IN_PROGRESS', '')], 'pending'],
      [[run('COMPLETED', 'FAILURE')], 'failing'],
      [[{ __typename: 'StatusContext', context: 'tests', state: 'SUCCESS' }], 'passing'],
      [[{ __typename: 'StatusContext', context: 'tests', state: 'ERROR' }], 'failing'],
      [
        [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        'missing',
      ],
      // A rerun (started later) supersedes the earlier failure, whatever the listing order.
      [
        [
          run('COMPLETED', 'SUCCESS', '2026-10-07T15:00:00Z'),
          run('COMPLETED', 'FAILURE', '2026-10-07T14:00:00Z'),
        ],
        'passing',
      ],
    ];
    for (const [rollup, state] of cases) {
      expect(await policy('tests', withRollup(rollup))).toMatchObject({
        requirement: 'required',
        checks_state: state,
      });
    }
  });

  test('holds on a malformed declaration or unreadable check results', async () => {
    expect(await policy('tests, none', freePrivate)).toMatchObject({ requirement: 'unknown' });
    expect(await policy('tests', freePrivate)).toMatchObject({
      requirement: 'required',
      checks_state: 'unknown',
    });
  });
});

describe('protected-path policy script', () => {
  const pr = 'https://github.test/owner/repo/pull/17';
  const head = 'head-17';
  const filesPath = 'api --paginate repos/owner/repo/pulls/17/files?per_page=100';
  const listing = (files: Array<string | [string, string]>) =>
    files
      .map(file =>
        JSON.stringify(
          typeof file === 'string'
            ? { filename: file, previous_filename: null }
            : { filename: file[0], previous_filename: file[1] }
        )
      )
      .join('\n') + '\n';

  async function paths(
    protectedPaths: string,
    files: Array<string | [string, string]>,
    overrides: Record<string, { stdout?: string; exit?: number }> = {},
    prs: string[] = [pr]
  ): Promise<{ policy: Record<string, unknown>; calls: string[][] }> {
    const dir = await mkdtemp(join(root, 'path-policy-'));
    const fixture = join(dir, 'gh.json');
    const log = join(dir, 'gh.jsonl');
    await writeFile(
      fixture,
      JSON.stringify({
        'pr view 17 --repo owner/repo': {
          stdout: JSON.stringify({ headRefOid: head, changedFiles: files.length }),
        },
        [filesPath]: { stdout: listing(files) },
        ...overrides,
      })
    );
    const result = run(pathPolicyScript, {
      INPUTS_PRS: JSON.stringify(prs),
      INPUTS_PROTECTED_PATHS: protectedPaths,
      GH_FIXTURE: fixture,
      GH_LOG: log,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    });
    expect(result.exitCode).toBe(0);
    let calls: string[][] = [];
    try {
      calls = (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as string[]);
    } catch {
      calls = [];
    }
    return { policy: JSON.parse(stdout(result)) as Record<string, unknown>, calls };
  }

  const governance =
    'MISSION.md,engineering.md,docs/ART-DIRECTION.md,harness/**,.factory/**,factory/';

  test('holds a PR that changes a protected file and names the files', async () => {
    const { policy } = await paths(governance, ['game/Main.cs', 'engineering.md', 'MISSION.md']);
    expect(policy).toMatchObject({
      state: 'protected',
      heads: [{ pr, head_sha: head }],
      matches: [{ pr, head_sha: head, files: ['MISSION.md', 'engineering.md'] }],
    });
    expect(policy.reason).toBe(
      `${pr} changes protected paths MISSION.md, engineering.md; a human must make this change`
    );
  });

  test('clears a PR that touches no protected path, and records the head it checked', async () => {
    const { policy } = await paths(governance, [
      'game/Main.cs',
      'sim/NorthStar.Sim/Tick.cs',
      'docs/visual/target/plaza-wide.png',
      'sub/MISSION.md',
      'engineering.md.bak',
      'harnessed/x.cs',
    ]);
    expect(policy).toMatchObject({
      state: 'clear',
      heads: [{ pr, head_sha: head }],
      matches: [],
      reason: '',
    });
  });

  test('glob semantics: anchored, * in one segment, ** across segments, trailing / is a directory', async () => {
    const cases: Array<[string, string, boolean]> = [
      ['harness/**', 'harness/END-TO-END.md', true],
      ['harness/**', 'harness/deep/nested/file.json', true],
      ['harness/**', 'game/harness/file.cs', false],
      ['factory/', 'factory/consumer.py', true],
      ['factory/', 'factory/a/b.py', true],
      ['/MISSION.md', 'MISSION.md', true],
      ['docs/*.md', 'docs/north-star.prd.md', true],
      ['docs/*.md', 'docs/visual/notes.md', false],
      ['**/*.gdshader', 'game/art/shaders/fire.gdshader', true],
      ['**/*.gdshader', 'fire.gdshader', true],
      ['docs/?.md', 'docs/a.md', true],
      ['docs/?.md', 'docs/ab.md', false],
      ['a.b', 'axb', false],
    ];
    for (const [pattern, file, protects] of cases) {
      const { policy } = await paths(pattern, [file]);
      expect([pattern, file, policy.state]).toEqual([
        pattern,
        file,
        protects ? 'protected' : 'clear',
      ]);
    }
  });

  test('a rename out of a protected path is a change to it', async () => {
    const { policy } = await paths('MISSION.md', [['docs/MISSION-old.md', 'MISSION.md']]);
    expect(policy).toMatchObject({
      state: 'protected',
      matches: [{ files: ['MISSION.md'] }],
    });
  });

  test('reads every page of changed files, and a short listing is unknown', async () => {
    const many = Array.from({ length: 250 }, (_, index) => `game/file${index}.cs`);
    const { policy, calls } = await paths('MISSION.md', [...many, 'MISSION.md']);
    expect(policy).toMatchObject({ state: 'protected', matches: [{ files: ['MISSION.md'] }] });
    expect(calls.some(call => call.includes('--paginate'))).toBe(true);

    const short = await paths('MISSION.md', ['game/a.cs'], {
      'pr view 17 --repo owner/repo': {
        stdout: JSON.stringify({ headRefOid: head, changedFiles: 3001 }),
      },
    });
    expect(short.policy).toMatchObject({ state: 'unknown' });
    expect(short.policy.reason).toContain('listed 1 of 3001');
  });

  test('nothing declared protects nothing and reads nothing', async () => {
    for (const declared of ['', 'none', '  ']) {
      const { policy, calls } = await paths(declared, ['MISSION.md']);
      expect(policy).toMatchObject({ state: 'not_applicable', heads: [], matches: [] });
      expect(calls).toEqual([]);
    }
  });

  test('an unreadable PR, file list or declaration is unknown, never clear', async () => {
    expect(
      (await paths('MISSION.md', [], { 'pr view 17 --repo owner/repo': { stdout: '', exit: 1 } }))
        .policy
    ).toMatchObject({
      state: 'unknown',
      reason: expect.stringContaining('could not read pull request'),
    });
    expect(
      (await paths('MISSION.md', [], { [filesPath]: { stdout: '', exit: 1 } })).policy
    ).toMatchObject({ state: 'unknown', reason: expect.stringContaining('could not list') });
    expect((await paths('MISSION.md', [], { [filesPath]: { stdout: '{' } })).policy).toMatchObject({
      state: 'unknown',
      reason: expect.stringContaining('could not parse'),
    });
    expect((await paths('MISSION.md, ,harness/**', ['a.cs'])).policy).toMatchObject({
      state: 'unknown',
      reason: expect.stringContaining('protected_paths must be'),
    });
    expect((await paths('MISSION.md', ['a.cs'], {}, ['not a url'])).policy).toMatchObject({
      state: 'unknown',
    });
  });
});

describe('merge gate enforces the protected-path policy', () => {
  async function gateWith(pathPolicy: unknown): Promise<Record<string, unknown>> {
    const { artifacts, content } = await mergeFixture();
    const env: Record<string, string> = {
      ARTIFACTS_DIR: artifacts,
      INPUTS_ACTION: 'gate',
      INPUTS_ASSESSMENT: JSON.stringify(assessment(content)),
      INPUTS_CI_POLICY: JSON.stringify({ requirement: 'none', checks_state: 'not_applicable' }),
      INPUTS_MERGE_METHOD: 'squash',
    };
    if (pathPolicy !== undefined) {
      env.INPUTS_PATH_POLICY =
        typeof pathPolicy === 'string' ? pathPolicy : JSON.stringify(pathPolicy);
    }
    const result = run(mergeScript, env);
    expect(result.exitCode).toBe(0);
    return JSON.parse(stdout(result)) as Record<string, unknown>;
  }
  const url = 'https://github.test/owner/repo/pull/17';

  test('a protected change holds even when the assessment says eligible', async () => {
    expect(
      await gateWith({
        state: 'protected',
        heads: [{ pr: url, head_sha: 'head-17' }],
        matches: [{ pr: url, head_sha: 'head-17', files: ['MISSION.md'] }],
        reason: `${url} changes protected path MISSION.md; a human must make this change`,
      })
    ).toMatchObject({
      ready: false,
      summary: expect.stringContaining('protected paths changed'),
    });
  });

  test('clear merges only when it checked the planned head', async () => {
    expect(
      await gateWith({
        state: 'clear',
        heads: [{ pr: url, head_sha: 'head-17' }],
        matches: [],
        reason: '',
      })
    ).toMatchObject({ ready: true });
    expect(
      await gateWith({
        state: 'clear',
        heads: [{ pr: url, head_sha: 'older' }],
        matches: [],
        reason: '',
      })
    ).toMatchObject({
      ready: false,
      summary: expect.stringContaining('not checked at the planned head'),
    });
    expect(await gateWith({ state: 'clear', heads: [], matches: [], reason: '' })).toMatchObject({
      ready: false,
    });
  });

  test('not applicable passes; unknown, empty or malformed holds; an unwired caller is unaffected', async () => {
    expect(
      await gateWith({ state: 'not_applicable', heads: [], matches: [], reason: '' })
    ).toMatchObject({
      ready: true,
    });
    for (const policy of [
      { state: 'unknown', reason: 'could not list' },
      '',
      '{"state":"maybe"}',
    ]) {
      expect(await gateWith(policy)).toMatchObject({
        ready: false,
        summary: expect.stringContaining('protected-path policy is unknown'),
      });
    }
    expect(await gateWith(undefined)).toMatchObject({ ready: true });
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
