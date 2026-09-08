import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { parseWorkflow } from '../../../../../packages/workflows/src/loader';
import {
  dryRunResultSchema,
  type DryRunResult,
} from '../../../../../packages/workflows/src/dry-run';
import { expandWorkflowIncludes } from '../../../../../packages/workflows/src/include-expander';
import {
  collectExecInputValidationTargets,
  validateExecInputTargets,
} from '../../../../../packages/workflows/src/exec-input-validation';
import {
  decide,
  digest,
  parseJudgment,
  parseProfile,
  parseReceipt,
  parseTarget,
  type Check,
  type Identity,
  type Judgment,
  type Profile,
} from '../scripts/accept';

const track = trackTempRoots();
const script = resolve(import.meta.dir, '../scripts/accept.ts');
const pack = resolve(import.meta.dir, '../..');
const workflowFixture = resolve(import.meta.dir, 'workflow-fixture.ts');
let commandHarness: string;
beforeAll(async () => {
  commandHarness = await mkdtemp(join(tmpdir(), 'accept-gh-'));
  const harness = join(commandHarness, 'gh.ts');
  await writeFile(
    harness,
    `const args = process.argv.slice(2); if (JSON.stringify(args) !== JSON.stringify(['api','repos/unit/project/pulls/7'])) process.exit(2); console.log(await Bun.file(process.env.FIXTURE_PR!).text());`
  );
  if (process.platform === 'win32')
    await exec(
      [
        process.execPath,
        'build',
        '--compile',
        harness,
        '--outfile',
        join(commandHarness, 'gh.exe'),
      ],
      commandHarness
    );
  else {
    const gh = join(commandHarness, 'gh');
    await writeFile(gh, `#!/bin/sh\nexec '${process.execPath}' '${harness}' "$@"\n`);
    await chmod(gh, 0o755);
  }
});
afterAll(async () => {
  if (commandHarness) await removeTempTree(commandHarness);
});
const identity: Identity = {
  repository: { owner: 'unit', name: 'project' },
  pr: 7,
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
};
const check: Check = {
  id: 'gate',
  identity,
  argv: null,
  command_sha256: digest('command'),
  source: 'trusted_policy',
  exit_code: 0,
  status: 'passed',
  stdout: 'accept-private/gate.stdout',
  stderr: 'accept-private/gate.stderr',
  stdout_sha256: digest('actual evidence'),
  stderr_sha256: digest(''),
  timestamp: new Date().toISOString(),
};
const judgment: Judgment = {
  verdict: 'approve',
  summary: 'The requested behavior is established.',
  findings: [],
  requirements: [
    { request: 'Return the new value.', met: true, evidence: ['value.txt:1 and gate output'] },
  ],
  checks_complete: true,
  evidence_sufficient: true,
  checks_weakened: false,
};

describe('acceptance decision', () => {
  test('approves only evidence for the exact identity', () => {
    expect(decide(identity, [check], [], false, judgment).verdict).toBe('approve');
    expect(
      decide(
        identity,
        [{ ...check, identity: { ...identity, head_sha: 'c'.repeat(40) } }],
        [],
        false,
        judgment
      ).verdict
    ).toBe('inconclusive');
  });
  test('semantic mismatch and partial completion survive green checks', () => {
    expect(
      decide(identity, [check], [], false, { ...judgment, verdict: 'request_changes' }).verdict
    ).toBe('request_changes');
    expect(
      decide(identity, [check], [], false, {
        ...judgment,
        requirements: [{ ...judgment.requirements[0], met: false }],
      }).verdict
    ).toBe('request_changes');
  });
  test('deterministic defects cannot be approved', () => {
    expect(
      decide(identity, [{ ...check, exit_code: 1, status: 'failed' }], [], false, judgment).verdict
    ).toBe('request_changes');
    expect(
      decide(identity, [check], [], false, { ...judgment, checks_weakened: true }).verdict
    ).toBe('request_changes');
  });
  test('a supported refusal survives incomplete preservation evidence', () => {
    const refusal: Judgment = {
      ...judgment,
      verdict: 'request_changes',
      summary: 'The required response header is missing.',
      findings: [{ code: 'missing_header', summary: 'Return the required header.', evidence: ['handler diff'] }],
      checks_complete: false,
      evidence_sufficient: false,
      requirements: [{ request: 'Preserve existing invariants.', met: false, evidence: [] }],
    };
    expect(decide(identity, [check], [], false, refusal)).toMatchObject({
      verdict: 'request_changes', summary: refusal.summary,
    });
    expect(decide(identity, [check], [], false, refusal).findings).toContainEqual(refusal.findings[0]);
  });
  test('a refusal carried only by an unmet requirement stays actionable', () => {
    const refusal: Judgment = {
      ...judgment,
      verdict: 'request_changes',
      summary: 'The requested header is never returned.',
      findings: [],
      requirements: [{ request: 'Return the header.', met: false, evidence: ['handler diff hunk'] }],
    };
    expect(decide(identity, [check], [], false, refusal)).toEqual({
      verdict: 'request_changes',
      summary: refusal.summary,
      findings: [
        { code: 'requirement_unmet', summary: 'Return the header.', evidence: ['handler diff hunk'] },
      ],
    });
    expect(
      decide(identity, [check], [], false, { ...refusal, requirements: [{ ...refusal.requirements[0], evidence: [] }] })
        .verdict
    ).toBe('inconclusive');
  });
  test('missing checks, environment, missing judgment and clipped evidence fail closed', () => {
    expect(decide(identity, [], [], false, judgment).verdict).toBe('inconclusive');
    expect(decide(null, [check], [], false, judgment).verdict).toBe('inconclusive');
    expect(
      decide(identity, [{ ...check, exit_code: null, status: 'environment' }], [], false, judgment)
        .verdict
    ).toBe('inconclusive');
    expect(decide(identity, [check], [], true, judgment).verdict).toBe('inconclusive');
    expect(decide(identity, [check], [], false, null).verdict).toBe('inconclusive');
    expect(
      decide(identity, [check], [], false, { ...judgment, evidence_sufficient: false }).verdict
    ).toBe('inconclusive');
    expect(
      decide(identity, [check], [], false, { ...judgment, checks_complete: false }).verdict
    ).toBe('inconclusive');
    expect(decide(identity, [check], [], false, { ...judgment, requirements: [] }).verdict).toBe(
      'inconclusive'
    );
    expect(
      decide(identity, [check], [], false, {
        ...judgment,
        requirements: [{ ...judgment.requirements[0], evidence: [] }],
      }).verdict
    ).toBe('inconclusive');
  });
  test('validates target, profile and judgment at the wire boundary', () => {
    expect(parseTarget('https://github.com/unit/project/pull/7')).toEqual(
      parseTarget('unit/project#7')
    );
    for (const target of [
      '7',
      'https://evil.test/unit/project/pull/7',
      'unit/project#0',
      'unit/project#7;echo bad',
    ])
      expect(() => parseTarget(target)).toThrow();
    expect(() => parseProfile({ schema_version: 2 })).toThrow();
    expect(() => parseProfile({ ...profile(), protected_paths: ['../escape'] })).toThrow();
    expect(() => parseProfile({ ...profile(), require_isolation: 'false' })).toThrow();
    expect(() => parseProfile({ ...profile(), unknown: true })).toThrow();
    expect(() => parseProfile({ ...profile(), gate: { complete: true, description: 'Full gate' } })).toThrow();
    expect(() => parseProfile({ ...profile(), context: [{ id: 'source', source: 'candidate.txt' }] })).toThrow();
    for (const path of ['.git/config', 'reports/*.json', 'reports/file:stream', 'reports/../old.json'])
      expect(() => parseProfile({ ...profile(), required_evidence: [path] })).toThrow();
    expect(() => parseJudgment({ ...judgment, evidence_sufficient: 'yes' })).toThrow();
    expect(() => parseReceipt({ verdict: 'approve' })).toThrow();
  });
  test('execution settings default conservatively and reject values outside their bounds', () => {
    const command = { id: 'gate', argv: ['gate'], environment_exit_codes: [] };
    const minimal = {
      schema_version: 1,
      commands: [command],
      required_evidence: [],
      protected_paths: [],
      require_isolation: false,
    };
    expect(parseProfile(minimal)).toMatchObject({
      commands: [{ timeout_seconds: 600 }],
      max_packet_bytes: 96_000,
    });
    expect(
      parseProfile({
        ...minimal,
        commands: [{ ...command, timeout_seconds: 7200 }],
        max_packet_bytes: 512_000,
      })
    ).toMatchObject({ commands: [{ timeout_seconds: 7200 }], max_packet_bytes: 512_000 });
    for (const timeout_seconds of [0, -1, 7201, 600.5, Number.NaN, Infinity, '600', null])
      expect(() =>
        parseProfile({ ...minimal, commands: [{ ...command, timeout_seconds }] })
      ).toThrow();
    for (const max_packet_bytes of [0, -1, 512_001, 96_000.5, Number.NaN, Infinity, '96000', null])
      expect(() => parseProfile({ ...minimal, max_packet_bytes })).toThrow();
  });
  test('the workflow parses with existing node and input schemas', async () => {
    const workflow = parseWorkflow(
      await readFile(resolve(import.meta.dir, '../archon-accept.yaml'), 'utf8'),
      'archon-accept.yaml'
    );
    expect(workflow).toMatchObject({ error: null, workflow: { returns: 'receipt' } });
    if (!workflow.workflow) throw new Error('Invalid acceptance workflow');
    const source = await readFile(script, 'utf8');
    expect(
      validateExecInputTargets(
        workflow.workflow,
        collectExecInputValidationTargets(workflow.workflow),
        () => ({ text: source, label: 'accept.ts', runtime: 'bun' })
      ).errors
    ).toEqual([]);
    const node = workflow.workflow.nodes.find(n => n.id === 'judge');
    if (!node || node.kind !== 'agent') throw new Error('Missing judge');
    expect(Object.keys(node.output_format?.properties ?? {}).sort()).toEqual(
      Object.keys(judgment).sort()
    );
    expect(node.output_format?.required).toEqual(Object.keys(node.output_format?.properties ?? {}));
    const validate = parseWorkflow(
      await readFile(resolve(import.meta.dir, '../../validate/archon-validate.yaml'), 'utf8'),
      'archon-validate.yaml'
    );
    if (!validate.workflow) throw new Error('Missing validation workflow');
    const parent = parseWorkflow(
      `name: parent\ndescription: Acceptance composition\nreturns: accept\nnodes:\n  - id: accept\n    include: archon-accept\n    with:\n      target: unit/project#7\n      work_order: Original request\n`,
      'parent.yaml'
    );
    if (!parent.workflow) throw new Error('Invalid fixture parent');
    const expanded = expandWorkflowIncludes(
      new Map([workflow.workflow, validate.workflow, parent.workflow].map(w => [w.name, w])),
      new Map([
        ['judge', await readFile(resolve(import.meta.dir, '../commands/judge.md'), 'utf8')],
        [
          'validate',
          await readFile(resolve(import.meta.dir, '../../validate/commands/validate.md'), 'utf8'),
        ],
      ])
    );
    expect(expanded.errors).toEqual([]);
    expect(expanded.workflows.get('parent')?.returns).toBe('accept__receipt');
  });
});

function profile(code = 'console.log("checked new behavior")'): Profile {
  return {
    schema_version: 1,
    commands: [
      {
        id: 'gate',
        argv: [process.execPath, '-e', code],
        environment_exit_codes: [75],
        timeout_seconds: 600,
      },
    ],
    required_evidence: [],
    protected_paths: [],
    require_isolation: false,
    max_packet_bytes: 96_000,
  };
}
async function exec(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const p = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`Fixture subprocess exited ${code}: ${stderr}`);
  return stdout.trim();
}
async function fixture(policy: Profile | null = profile()): Promise<{
  root: string;
  cwd: string;
  artifacts: string;
  state: string;
  env: NodeJS.ProcessEnv;
  move: (side: 'head' | 'base') => Promise<void>;
  phase: (phase: string, extra?: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>;
  discover: () => Promise<unknown>;
  dryRun: (extra?: NodeJS.ProcessEnv) => Promise<DryRunResult>;
}> {
  const root = track(await mkdtemp(join(tmpdir(), 'accept-test-')));
  const cwd = join(root, 'app');
  const origin = join(root, 'origin');
  const artifacts = join(root, 'artifacts');
  const home = join(root, 'home');
  const project = join(root, 'project');
  const temp = join(root, 'temp');
  for (const dir of [cwd, origin, artifacts, home]) await mkdir(dir);
  await exec(['git', 'init', '-b', 'integration'], origin);
  await exec(['git', 'config', 'user.name', 'Fixture'], origin);
  await exec(['git', 'config', 'user.email', 'fixture@example.invalid'], origin);
  await writeFile(join(origin, 'value.txt'), 'old\n');
  await writeFile(join(origin, 'checks.txt'), 'Use the operator-defined fixture gate.\n');
  await writeFile(join(origin, 'policy.json'), JSON.stringify(profile()));
  await exec(['git', 'add', 'value.txt', 'checks.txt', 'policy.json'], origin);
  await exec(['git', 'commit', '-m', 'base'], origin);
  const base = await exec(['git', 'rev-parse', 'HEAD'], origin);
  await writeFile(join(origin, 'value.txt'), 'new\n');
  await writeFile(join(origin, 'policy.json'), JSON.stringify({ ...profile(), commands: [] }));
  await exec(['git', 'add', 'value.txt', 'policy.json'], origin);
  await exec(['git', 'commit', '-m', 'candidate'], origin);
  const head = await exec(['git', 'rev-parse', 'HEAD'], origin);
  const pr = {
    state: 'open',
    merged: false,
    draft: false,
    title: 'Resolve issue #3',
    body: 'Closes #3. The full application gate passed.',
    html_url: 'https://github.com/unit/project/pull/7',
    number: 7,
    base: { sha: base, ref: 'integration', repo: { full_name: 'unit/project' } },
    head: { sha: head, ref: 'feature' },
  };
  const response = join(root, 'pr.json');
  await writeFile(response, JSON.stringify(pr));
  const config = join(root, 'gitconfig');
  await writeFile(
    config,
    `[url "${origin.replaceAll('\\', '/')}"]\n insteadOf = https://github.com/unit/project.git\n`
  );
  const policyPath = join(root, 'profile.json');
  if (policy) await writeFile(policyPath, JSON.stringify(policy));
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')
  );
  const env = {
    ...inheritedEnv,
    PATH: `${commandHarness}${delimiter}${process.env.PATH}`,
    DATABASE_URL: '',
    // Fixture stdout is a JSON protocol, independent of the operator's log level.
    LOG_LEVEL: 'error',
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    FIXTURE_PR: response,
    ARTIFACTS_DIR: artifacts,
    INPUTS_TARGET: 'unit/project#7',
    INPUTS_WORK_ORDER: 'Change value.txt to new. Preserve the check definition.',
    INPUTS_POLICY: policy ? policyPath : '',
  };
  const state = join(artifacts, 'accept-private', 'state.json');
  // The installed shape a real run reads: the pack's own files, without its tests,
  // under a project that holds nothing else for discovery to trip over. The temporary
  // directory moves under the tracked root so an interrupted run leaks nothing.
  const install = async (): Promise<NodeJS.ProcessEnv> => {
    for (const workflow of ['accept', 'validate'])
      await cp(join(pack, workflow), join(project, '.archon', 'workflows', 'sdlc', workflow), {
        recursive: true,
        filter: source => basename(source) !== 'tests',
      });
    await mkdir(temp, { recursive: true });
    return {
      ...env,
      ARCHON_HOME: home,
      TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
      INPUTS_JUDGMENT: JSON.stringify(judgment),
    };
  };
  return {
    root,
    cwd,
    artifacts,
    state,
    env,
    discover: async () =>
      JSON.parse(
        await exec([process.execPath, workflowFixture, project, 'discover'], cwd, await install())
      ),
    dryRun: async (extra = {}) =>
      dryRunResultSchema.parse(
        JSON.parse(
          await exec([process.execPath, workflowFixture, project], cwd, {
            ...(await install()),
            ...extra,
          })
        )
      ),
    move: async side => {
      pr[side].sha = side === 'head' ? base : head;
      await writeFile(response, JSON.stringify(pr));
    },
    phase: async (phase, extra = {}) =>
      JSON.parse(
        await exec([process.execPath, script, phase], cwd, {
          ...env,
          INPUTS_STATE: state,
          INPUTS_JUDGMENT: JSON.stringify(judgment),
          INPUTS_VALIDATION: JSON.stringify({
            green: true,
            red_cause: '',
            summary: 'Recorded gate complete.',
          }),
          ...extra,
        })
      ) as Record<string, unknown>,
  };
}
async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  extra: NodeJS.ProcessEnv = {}
): Promise<void> {
  await f.phase('prepare', extra);
  const state = JSON.parse(await readFile(f.state, 'utf8')) as {
    root: string;
    blockers: { code: string }[];
  };
  track(state.root);
  if (state.blockers.some(b => b.code === 'preparation_failed'))
    throw new Error(
      await readFile(join(f.artifacts, 'accept-private', 'preparation-error.json'), 'utf8')
    );
}

describe('real acceptance CLI with temporary Git and GitHub harness', () => {
  test('fixed gate runs in the exact candidate, returns and writes a valid receipt, cleans only its workspace', async () => {
    const f = await fixture(
      profile(
        'if (await Bun.file("value.txt").text() !== "new\\n") process.exit(1); console.log("verified actual file")'
      )
    );
    await writeFile(join(f.cwd, 'operator.txt'), 'preserve');
    await prepared(f);
    expect((await f.phase('collect')).judge).toBe(true);
    const receipt = parseReceipt(await f.phase('finish'));
    expect(receipt.verdict).toBe('approve');
    expect(receipt.checks[0].exit_code).toBe(0);
    expect(receipt.checks[0].argv).toBeNull();
    expect(await readFile(join(f.artifacts, receipt.checks[0].stdout), 'utf8')).toContain(
      'verified actual file'
    );
    expect(
      parseReceipt(JSON.parse(await readFile(join(f.artifacts, 'acceptance.json'), 'utf8')))
    ).toEqual(receipt);
    expect(await readFile(join(f.cwd, 'operator.txt'), 'utf8')).toBe('preserve');
    const manifest = JSON.parse(await readFile(f.state, 'utf8')) as { root: string };
    expect(await Bun.file(join(manifest.root, 'candidate', 'value.txt')).exists()).toBe(false);
    expect(() => parseReceipt({ ...receipt, head_sha: null })).toThrow();
    expect(() => parseReceipt({ ...receipt, checks: [] })).toThrow();
  });
  for (const [exit, expected] of [
    [1, 'request_changes'],
    [75, 'inconclusive'],
  ] as const) {
    test(`exit ${exit} cannot be overridden by approval`, async () => {
      const f = await fixture(
        profile(`console.error("private evaluator detail"); process.exit(${exit})`)
      );
      await prepared(f);
      expect((await f.phase('collect')).judge).toBe(false);
      const r = await f.phase('finish');
      expect(r.verdict).toBe(expected);
      expect(JSON.stringify(r)).not.toContain('private evaluator detail');
    });
  }
  test('generic no checks never approves', async () => {
    const f = await fixture(null);
    await prepared(f);
    expect((await f.phase('collect')).judge).toBe(false);
    expect((await f.phase('finish')).verdict).toBe('inconclusive');
  });
  test('generic recorder captures real commands', async () => {
    const g = await fixture(null);
    await prepared(g);
    await exec(
      [
        process.execPath,
        script,
        'record',
        g.state,
        'checks.txt',
        JSON.stringify([process.execPath, '-e', 'console.log("real ordinary gate")']),
      ],
      g.cwd,
      g.env
    );
    expect((await g.phase('collect')).judge).toBe(true);
    expect((await g.phase('finish')).verdict).toBe('approve');
  });
  test('missing required evidence is inconclusive', async () => {
    const f = await fixture({ ...profile(), required_evidence: ['missing.txt'] });
    await prepared(f);
    await f.phase('collect');
    expect((await f.phase('finish')).verdict).toBe('inconclusive');
  });
  test('a tracked report and a command producing nothing cannot satisfy fresh evidence', async () => {
    const f = await fixture({ ...profile(), required_evidence: ['value.txt'] });
    await prepared(f);
    expect((await f.phase('collect')).judge).toBe(false);
    const receipt = parseReceipt(await f.phase('finish'));
    expect(receipt.verdict).toBe('inconclusive');
    expect(receipt.checks).toEqual([]);
  });
  test('existing untracked output is refused without deleting it', async () => {
    const f = await fixture({ ...profile(), required_evidence: ['report.json'] });
    await prepared(f);
    const state = JSON.parse(await readFile(f.state, 'utf8')) as { root: string };
    const report = join(state.root, 'candidate', 'report.json');
    await writeFile(report, 'old evidence');
    expect((await f.phase('collect')).judge).toBe(false);
    expect(await readFile(report, 'utf8')).toBe('old evidence');
    expect(parseReceipt(await f.phase('finish')).checks).toEqual([]);
  });
  for (const wrong of ['evaluation', 'head', 'base'] as const) {
    test(`generated evidence bound to another ${wrong} cannot approve`, async () => {
      const f = await fixture({
        ...profile(`const identity = JSON.parse(process.env.ACCEPT_IDENTITY);
          ${wrong === 'evaluation' ? '' : `identity.${wrong}_sha = 'c'.repeat(40);`}
          await Bun.write('report.json', JSON.stringify({schema_version: 1,
            evaluation_id: ${wrong === 'evaluation' ? '"old-evaluation"' : 'process.env.ACCEPT_EVALUATION_ID'},
            identity, evidence: 'Fresh observations'}));`),
        required_evidence: ['report.json'],
      });
      await prepared(f);
      expect((await f.phase('collect')).judge).toBe(false);
      expect((await f.phase('finish')).verdict).toBe('inconclusive');
    });
  }
  test('public gate, trusted context, PR metadata and fresh baseline evidence reach the judge', async () => {
    const f = await fixture();
    const context = join(f.root, 'operator-context.md');
    await writeFile(context, 'Preserve the existing data contract.');
    const evaluator = join(f.root, 'private-evaluator.ts');
    await writeFile(evaluator, `
      const test = 'if ((await Bun.file("value.txt").text()).trim() !== "new") process.exit(1)';
      const baseline = Bun.spawnSync([process.execPath, '-e', test], {cwd: process.env.ACCEPT_BASE_DIR});
      const candidate = Bun.spawnSync([process.execPath, '-e', test], {cwd: process.env.ACCEPT_CANDIDATE_DIR});
      if (baseline.exitCode !== 1 || candidate.exitCode !== 0) process.exit(1);
      console.log('private evaluator implementation detail');
      await Bun.write('reports/behavior.json', JSON.stringify({schema_version: 1,
        evaluation_id: process.env.ACCEPT_EVALUATION_ID,
        identity: JSON.parse(process.env.ACCEPT_IDENTITY),
        evidence: 'The added value assertion fails on prior application (exit 1) and passes on candidate (exit 0).'}));
    `);
    const policy: Profile = {
      ...profile(),
      gate: { complete: true, description: 'Full application value contract gate, including baseline comparison.' },
      commands: [{ id: 'gate', argv: [process.execPath, evaluator], environment_exit_codes: [75],
        timeout_seconds: 900,
        public_description: 'Run the value assertion against candidate and prior application.' }],
      context: [{ id: 'checks', source: 'base:checks.txt' }, { id: 'invariants', source: context }],
      required_evidence: ['reports/behavior.json'],
    };
    await writeFile(f.env.INPUTS_POLICY || '', JSON.stringify(policy));
    await prepared(f);
    const collected = await f.phase('collect');
    expect(collected.judge).toBe(true);
    const packet = JSON.parse(String(collected.packet));
    expect(packet.gate).toMatchObject({ mode: 'fixed', declaration: policy.gate,
      settings: { max_packet_bytes: 96_000 },
      commands: [{ id: 'gate', description: policy.commands[0].public_description,
        timeout_seconds: 900 }] });
    expect(packet.source_context).toMatchObject([
      { id: 'checks', source: 'base:checks.txt', content: 'Use the operator-defined fixture gate.\n' },
      { id: 'invariants', source: 'external', content: 'Preserve the existing data contract.' },
    ]);
    expect(packet.pull_request).toMatchObject({ base_ref: 'integration', merged: false,
      title: 'Resolve issue #3', body: 'Closes #3. The full application gate passed.' });
    expect(packet.evidence[0].content).toContain('fails on prior application (exit 1)');
    expect(String(collected.packet)).not.toContain(evaluator.replaceAll('\\', '\\\\'));
    expect(String(collected.packet)).not.toContain('private evaluator implementation detail');
    expect(String(collected.packet)).not.toContain(context.replaceAll('\\', '\\\\'));
    expect((await f.phase('finish')).verdict).toBe('approve');
  });
  test('PR metadata changes invalidate the receipt', async () => {
    const f = await fixture();
    await prepared(f);
    await f.phase('collect');
    const path = join(f.root, 'pr.json');
    const pr = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...pr, body: 'Linkage removed' }));
    const receipt = parseReceipt(await f.phase('finish'));
    expect(receipt.verdict).toBe('inconclusive');
    expect(receipt.findings.some(f => f.code === 'pr_metadata_changed')).toBe(true);
  });
  for (const side of ['head', 'base'] as const) {
    test(`moved ${side} after evidence invalidates approval`, async () => {
      const f = await fixture();
      await prepared(f);
      await f.phase('collect');
      await f.move(side);
      expect((await f.phase('finish')).verdict).toBe('inconclusive');
    });
  }
  test('base policy cannot be replaced by candidate policy', async () => {
    const f = await fixture();
    await prepared(f, { INPUTS_POLICY: 'base:policy.json' });
    expect((await f.phase('collect')).judge).toBe(false);
    const r = await f.phase('finish');
    expect(r.verdict).toBe('inconclusive');
    expect(JSON.stringify(r.findings)).toContain('protected_changes');
  });
  test('strict unavailable isolation prevents execution', async () => {
    const f = await fixture({
      ...profile('throw new Error("must not run")'),
      require_isolation: true,
    });
    await prepared(f);
    await f.phase('collect');
    const r = await f.phase('finish');
    expect(r.verdict).toBe('inconclusive');
    expect(r.checks).toEqual([]);
    expect(JSON.stringify(r.findings)).toContain('isolation_unavailable');
  });
  test('unknown candidate identity writes an inconclusive receipt with original request identity', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'pr.json'), '{"state":"closed"}');
    await f.phase('prepare');
    const state = JSON.parse(await readFile(f.state, 'utf8')) as { root: string };
    track(state.root);
    await f.phase('collect');
    const r = parseReceipt(await f.phase('finish'));
    expect(r.verdict).toBe('inconclusive');
    expect(r.head_sha).toBeNull();
    expect(r.work_order_sha256).toBe(digest(f.env.INPUTS_WORK_ORDER || ''));
  });
  test('failed ordinary validation cannot certify a partial recorded gate', async () => {
    const f = await fixture(null);
    await prepared(f);
    await exec(
      [
        process.execPath,
        script,
        'record',
        f.state,
        'checks.txt',
        JSON.stringify([process.execPath, '-e', 'console.log("one gate only")']),
      ],
      f.cwd,
      f.env
    );
    await f.phase('collect', { INPUTS_VALIDATION: 'null' });
    expect((await f.phase('finish')).verdict).toBe('inconclusive');
  });
  test('changed logs cannot approve', async () => {
    const f = await fixture();
    await prepared(f);
    await f.phase('collect');
    await writeFile(join(f.artifacts, 'accept-private', 'gate.stdout'), 'tampered');
    expect((await f.phase('finish')).verdict).toBe('inconclusive');
  });
  test('malformed judgment cannot approve', async () => {
    const g = await fixture();
    await prepared(g);
    await g.phase('collect');
    expect((await g.phase('finish', { INPUTS_JUDGMENT: '{"verdict":"approve"}' })).verdict).toBe(
      'inconclusive'
    );
  });
  const recordOutput = async (
    f: Awaited<ReturnType<typeof fixture>>,
    characters: number
  ): Promise<void> => {
    await exec(
      [
        process.execPath,
        script,
        'record',
        f.state,
        'checks.txt',
        JSON.stringify([process.execPath, '-e', `console.log("x".repeat(${characters}))`]),
      ],
      f.cwd,
      f.env
    );
  };
  test('a packet larger than the former fixed budget reaches the judge', async () => {
    const f = await fixture(null);
    await prepared(f);
    await recordOutput(f, 30_000);
    const collected = await f.phase('collect');
    expect(Buffer.byteLength(String(collected.packet), 'utf8')).toBeGreaterThan(24_000);
    expect(collected.judge).toBe(true);
    const r = await f.phase('finish');
    expect(r.clipped).toBe(false);
    expect(r.verdict).toBe('approve');
  });
  test('material clipping above the budget is explicit and retained privately', async () => {
    const f = await fixture(null);
    await prepared(f);
    await recordOutput(f, 120_000);
    expect((await f.phase('collect')).judge).toBe(false);
    expect(
      (await readFile(join(f.artifacts, 'accept-private', 'packet.json'), 'utf8')).length
    ).toBeGreaterThan(96_000);
    const r = await f.phase('finish');
    expect(r.clipped).toBe(true);
    expect(r.verdict).toBe('inconclusive');
  });
  test('a trusted profile can lower the judge packet budget', async () => {
    const f = await fixture({ ...profile(), max_packet_bytes: 1000 });
    await prepared(f);
    const collected = await f.phase('collect');
    expect(collected.judge).toBe(false);
    expect(String(collected.packet)).toContain('exceeds 1000 bytes');
    expect((await f.phase('finish')).verdict).toBe('inconclusive');
  });
  test('an expired command timeout is an environment result, never a failure', async () => {
    const f = await fixture({
      ...profile(),
      commands: [
        {
          id: 'gate',
          argv: [process.execPath, '-e', 'await Bun.sleep(120_000)'],
          environment_exit_codes: [],
          timeout_seconds: 1,
        },
      ],
    });
    await prepared(f);
    expect((await f.phase('collect')).judge).toBe(false);
    const receipt = parseReceipt(await f.phase('finish'));
    expect(receipt.checks[0]).toMatchObject({ exit_code: null, status: 'environment' });
    expect(receipt.verdict).toBe('inconclusive');
  });
});

describe('the installed workflow through the engine dry run', () => {
  test('static discovery binds every phase of the shared script', async () => {
    expect(await (await fixture()).discover()).toEqual([]);
  });
  test('a configured gate skips ordinary validation and certifies the judgment', async () => {
    const result = await (await fixture()).dryRun();
    expect(result.outcome).toBe('completed');
    const states = new Map(result.trace.map(entry => [entry.nodeId, entry.state]));
    expect([...states].filter(([id]) => id.startsWith('validate')).map(([, s]) => s)).toEqual([
      'skipped',
    ]);
    expect(states.get('judge')).toBe('stubbed');
    expect(states.get('receipt')).toBe('completed');
    const receipt = parseReceipt(JSON.parse(String(result.summary)));
    expect(receipt.verdict).toBe('approve');
    expect(receipt.checks.map(c => c.id)).toEqual(['gate']);
    expect(receipt.judgment_sha256).toBe(digest(JSON.stringify(judgment)));
  });
  test('a preparation blocker skips the judge and still issues a receipt', async () => {
    const f = await fixture({
      ...profile('throw new Error("must not run")'),
      require_isolation: true,
    });
    const result = await f.dryRun();
    expect(result.outcome).toBe('completed');
    expect(result.trace.find(entry => entry.nodeId === 'judge')?.state).toBe('skipped');
    const receipt = parseReceipt(JSON.parse(String(result.summary)));
    expect(receipt.verdict).toBe('inconclusive');
    expect(receipt.findings.map(finding => finding.code)).toContain('isolation_unavailable');
    expect(receipt.judgment_sha256).toBeNull();
  });
});
