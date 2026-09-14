import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  console.log(JSON.stringify({state:'MERGED', mergedAt:'2026-09-14T00:00:00Z', mergeCommit:{oid:'abc'}, url:'https://example.test/pr/1'}));
}
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
  const plan = {
    repository: 'owner/repo',
    base: 'dev',
    base_sha: 'base',
    method,
    pull_requests: [
      { number: 17, url: 'https://github.test/owner/repo/pull/17', head_sha: 'head-17' },
    ],
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
  });

  test('holds missing, conflicting, and changed approvals without invoking gh', async () => {
    const { artifacts, content } = await mergeFixture();
    const gate = assessment(content);
    for (const changed of [
      { gate: { ...gate, ready: false }, mode: 'auto', approval: null },
      { gate: { ...gate, ready: true }, mode: 'approve', approval: { decision: 'hold' } },
      { gate: { ...gate, ready: true }, mode: 'approve', approval: null },
    ]) {
      const result = run(mergeScript, {
        ARTIFACTS_DIR: artifacts,
        INPUTS_ACTION: 'execute',
        INPUTS_GATE: JSON.stringify(changed.gate),
        INPUTS_MODE: changed.mode,
        INPUTS_APPROVAL: JSON.stringify(changed.approval),
        INPUTS_REQUEST: '{}',
        INPUTS_PREVIOUS: '',
        PATH: fakeBin,
      });
      expect(JSON.parse(stdout(result))).toMatchObject({ done: true, merged: false });
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
        GH_LOG: ghLog,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(stdout(result))).toMatchObject({ merged: true });
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
});
