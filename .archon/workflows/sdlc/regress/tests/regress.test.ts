import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  configuredEvidence,
  discoveredEvidence,
  githubRepository,
  issueBody,
  issueMarker,
  object,
  publish,
  readDiagnosis,
  runCommand,
  settle,
  type CommandResult,
  type Diagnosis,
  type Evidence,
  type Prepared,
  type PublicCase,
  type RunCommand,
} from '../scripts/regress.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempTree));
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'archon-regress-test-'));
  roots.push(root);
  return root;
}
const context: Prepared = {
  revision: 'a'.repeat(40),
  base: 'release/testing',
  base_revision: 'b'.repeat(40),
  scope: 'client',
  ready: true,
  mode: 'configured',
  reason: '',
  started: 0,
  directory: '',
  profile_hash: '',
};
const publicCase: PublicCase = {
  id: 'empty-input',
  root_cause_key: 'parser/empty-input',
  title: 'Empty input raises instead of returning a result',
  root_cause: 'The parser indexes the first element before checking length.',
  expected: 'Empty input returns an empty result.',
  actual: 'Empty input throws an exception.',
  reproduction: 'Run the repository empty-input parser test.',
  evidence: ['src/parser.ts:12 reads the first item'],
};
const execution: CommandResult = { exitCode: 1, stdout: 'private evaluator details', stderr: '' };
function report(status = 'product', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...context, status, public_cases: [publicCase], ...extra });
}
function evidence(): Evidence {
  return configuredEvidence(context, execution, report(), '/artifacts/evidence.json');
}
const diagnosis: Diagnosis = {
  status: 'defects',
  summary: 'One proven parser defect.',
  findings: [
    {
      public_case_id: publicCase.id,
      title: 'PRIVATE MODEL TITLE',
      root_cause: 'PRIVATE MODEL CAUSE',
      expected: 'expected',
      actual: 'actual',
      reproduction: 'PRIVATE MODEL COMMAND',
      evidence: ['PRIVATE MODEL LOG'],
    },
  ],
};
const clean: Diagnosis = { status: 'clean', summary: 'Checks passed.', findings: [] };

test('a real command timeout cannot certify a product assertion', async () => {
  const result = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], {
    timeout: 50,
  });
  expect(result.exitCode).toBeNull();
  expect(configuredEvidence(context, result, report(), 'evidence').status).toBe('inconclusive');
});

describe('evidence and judgment boundary', () => {
  test('collects a clean configured check and a reproducible product failure', () => {
    expect(
      configuredEvidence(context, { ...execution, exitCode: 0 }, report('clean'), 'evidence').status
    ).toBe('clean');
    expect(evidence().status).toBe('product');
    expect(settle(evidence(), diagnosis, true, true)).toEqual(diagnosis);
  });
  test.each(['missing tool', 'startup failed', 'browser missing'])(
    '%s without check evidence is inconclusive',
    () => {
      expect(configuredEvidence(context, execution, '', 'evidence').status).toBe('inconclusive');
      expect(
        configuredEvidence(context, execution, report('inconclusive'), 'evidence').status
      ).toBe('inconclusive');
    }
  );
  test('rejects timeouts, green/nonzero, product/zero, and mismatched revision, scope or base', () => {
    for (const exitCode of [null, 0])
      expect(
        configuredEvidence(context, { ...execution, exitCode }, report(), 'evidence').status
      ).toBe('inconclusive');
    expect(configuredEvidence(context, execution, report('clean'), 'evidence').status).toBe(
      'inconclusive'
    );
    for (const key of ['revision', 'scope', 'base', 'base_revision']) {
      expect(
        configuredEvidence(
          context,
          execution,
          report('product', { [key]: 'different' }),
          'evidence'
        ).status
      ).toBe('inconclusive');
    }
  });
  test('ordinary validation requires an actual artifact even when the model claims green', () => {
    expect(discoveredEvidence(context, { green: true, red_cause: '' }, '', 'report').status).toBe(
      'inconclusive'
    );
    expect(
      discoveredEvidence(context, { green: true, red_cause: '' }, 'test command: exit 0', 'report')
        .status
    ).toBe('clean');
    for (const red_cause of ['environment', '']) {
      expect(
        discoveredEvidence(context, { green: false, red_cause }, 'browser missing', 'report').status
      ).toBe('inconclusive');
    }
    expect(
      discoveredEvidence(context, { green: false, red_cause: 'inherited' }, 'test failed', 'report')
        .status
    ).toBe('product');
  });
  test('unrooted investigation, missing report, and contradictory diagnosis cannot yield defects', () => {
    expect(settle(evidence(), diagnosis, false, true).status).toBe('inconclusive');
    expect(settle(evidence(), diagnosis, true, false).status).toBe('inconclusive');
    expect(settle({ ...evidence(), status: 'inconclusive' }, diagnosis, true, true).status).toBe(
      'inconclusive'
    );
    expect(settle(evidence(), clean, true, true).status).toBe('inconclusive');
    expect(() => readDiagnosis({ ...diagnosis, findings: [] })).toThrow();
  });
  test('rejects duplicate public root identity and malformed public evidence', () => {
    expect(
      configuredEvidence(
        context,
        execution,
        report('product', { public_cases: [publicCase, publicCase] }),
        'evidence'
      ).status
    ).toBe('inconclusive');
    expect(
      configuredEvidence(
        context,
        execution,
        report('product', { public_cases: [{ ...publicCase, evidence: [] }] }),
        'evidence'
      ).status
    ).toBe('inconclusive');
  });
});

function fakeGithub(
  options: {
    existing?: boolean;
    failQuery?: boolean;
    failReadback?: boolean;
    wrongReadback?: boolean;
    failCreate?: boolean;
    canonicalCase?: boolean;
  } = {}
): {
  run: RunCommand;
  calls: string[][];
  bodies: string[];
} {
  const calls: string[][] = [];
  const bodies: string[] = [];
  let body = issueBody('owner/repo', publicCase, context.revision);
  const row = (): Record<string, unknown> => ({
    number: 7,
    html_url: options.canonicalCase
      ? 'https://github.com/Owner/Repo/issues/7'
      : 'https://github.com/owner/repo/issues/7',
    body,
  });
  const run: RunCommand = async (argv, input) => {
    calls.push(argv);
    if (argv.includes('--paginate'))
      return options.failQuery
        ? { exitCode: 1, stdout: '', stderr: 'private auth failure' }
        : {
            exitCode: 0,
            stdout: JSON.stringify([[], options.existing ? [row()] : []]),
            stderr: '',
          };
    if (argv.includes('POST')) {
      if (options.failCreate)
        return { exitCode: 1, stdout: '', stderr: 'ambiguous connection loss' };
      const payload = JSON.parse(input?.stdin ?? '{}');
      body = payload.body;
      bodies.push(input?.stdin ?? '');
      return { exitCode: 0, stdout: JSON.stringify(row()), stderr: '' };
    }
    return options.failReadback
      ? { exitCode: 1, stdout: '', stderr: 'readback unavailable' }
      : {
          exitCode: 0,
          stdout: JSON.stringify({ ...row(), ...(options.wrongReadback ? { body: 'wrong' } : {}) }),
          stderr: '',
        };
  };
  return { run, calls, bodies };
}
const record = async (): Promise<void> => {};
describe('deterministic GitHub publication', () => {
  test('clean and publish=false never call GitHub', async () => {
    const gh = fakeGithub();
    expect(
      (await publish(evidence(), diagnosis, false, 'owner/repo', record, gh.run)).publication
    ).toBe('disabled');
    expect((await publish(evidence(), clean, true, 'owner/repo', record, gh.run)).publication).toBe(
      'not-applicable'
    );
    expect(gh.calls).toHaveLength(0);
  });
  test('ordinary model evidence and invented public ids cannot authorize publication', async () => {
    const gh = fakeGithub();
    expect(
      (
        await publish(
          { ...evidence(), source: 'discovered' },
          diagnosis,
          true,
          'owner/repo',
          record,
          gh.run
        )
      ).publication
    ).toBe('blocked');
    expect(
      (
        await publish(
          evidence(),
          { ...diagnosis, findings: [{ ...diagnosis.findings[0], public_case_id: 'invented' }] },
          true,
          'owner/repo',
          record,
          gh.run
        )
      ).publication
    ).toBe('blocked');
    expect(gh.calls).toHaveLength(0);
  });
  test('creates and reads back an issue using only trusted public fields', async () => {
    const gh = fakeGithub();
    const snapshots: unknown[] = [];
    const result = await publish(
      evidence(),
      diagnosis,
      true,
      'owner/repo',
      async issues => {
        snapshots.push(structuredClone(issues));
      },
      gh.run,
      await temporary()
    );
    expect(result.publication).toBe('published');
    expect(result.issues[0]).toMatchObject({ number: 7, disposition: 'created', verified: true });
    expect(gh.calls).toHaveLength(3);
    expect(gh.bodies[0]).toContain(publicCase.root_cause);
    expect(gh.bodies[0]).not.toContain('PRIVATE');
    expect(gh.bodies[0]).not.toContain('private evaluator');
    expect(snapshots).toHaveLength(2);
  });
  test('known issues in any state are reused without a create, across revisions and scopes', async () => {
    const gh = fakeGithub({ existing: true, canonicalCase: true });
    const result = await publish(
      { ...evidence(), revision: 'c'.repeat(40), scope: 'another' },
      diagnosis,
      true,
      'owner/repo',
      record,
      gh.run,
      await temporary()
    );
    expect(result.issues[0]).toMatchObject({ disposition: 'existing', verified: true });
    expect(result.issues[0].url).toBe('https://github.com/Owner/Repo/issues/7');
    expect(gh.calls.some(argv => argv.includes('POST'))).toBe(false);
    expect(issueMarker('OWNER/REPO', publicCase.root_cause_key)).toBe(
      issueMarker('owner/repo', publicCase.root_cause_key)
    );
  });
  test('malformed successful query responses never authorize a create', async () => {
    for (const stdout of ['not JSON', JSON.stringify([[{ message: 'unclassified failure' }]])]) {
      const calls: string[][] = [];
      const result = await publish(
        evidence(),
        diagnosis,
        true,
        'owner/repo',
        record,
        async argv => {
          calls.push(argv);
          return { exitCode: 0, stdout, stderr: '' };
        },
        await temporary()
      );
      expect(result.publication).toBe('blocked');
      expect(calls).toHaveLength(1);
    }
  });
  test('query failure never becomes no matches and ambiguous creation is never retried', async () => {
    for (const options of [{ failQuery: true }, { failCreate: true }]) {
      const gh = fakeGithub(options);
      const result = await publish(
        evidence(),
        diagnosis,
        true,
        'owner/repo',
        record,
        gh.run,
        await temporary()
      );
      expect(result.publication).toBe('blocked');
      expect(gh.calls.filter(argv => argv.includes('POST'))).toHaveLength(
        options.failQuery ? 0 : 1
      );
      expect(JSON.stringify(result)).not.toContain('private auth');
    }
  });
  test.each([{ failReadback: true }, { wrongReadback: true }])(
    'preserves created references on failed readback %j',
    async options => {
      const gh = fakeGithub(options);
      const result = await publish(
        evidence(),
        diagnosis,
        true,
        'owner/repo',
        record,
        gh.run,
        await temporary()
      );
      expect(result.publication).toBe('blocked');
      expect(result.issues[0]).toMatchObject({
        number: 7,
        verified: false,
        disposition: 'created',
      });
    }
  );
  test('a second local publisher stops while the first holds the repository lock', async () => {
    const root = await temporary();
    const gh = fakeGithub();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(r => {
      entered = r;
    });
    const wait = new Promise<void>(r => {
      release = r;
    });
    const first = publish(
      evidence(),
      diagnosis,
      true,
      'owner/repo',
      record,
      async (argv, input) => {
        if (argv.includes('--paginate')) {
          entered();
          await wait;
        }
        return gh.run(argv, input);
      },
      root
    );
    await started;
    const second = await publish(evidence(), diagnosis, true, 'owner/repo', record, gh.run, root);
    expect(second.publication).toBe('blocked');
    expect(second.publication_reason).toContain('lock');
    release();
    expect((await first).publication).toBe('published');
  });
  test('normalizes GitHub remotes without exposing credentials and refuses other forges', () => {
    expect(githubRepository('https://secret@github.com/Owner/Repo.git')).toBe('owner/repo');
    expect(githubRepository('git@github.com:Owner/Repo.git')).toBe('owner/repo');
    expect(githubRepository('ssh://git@github.com/Owner/Repo.git')).toBe('owner/repo');
    expect(githubRepository('https://elsewhere.invalid/owner/repo')).toBeNull();
  });
});

const script = resolve(import.meta.dir, '../scripts/regress.ts');
async function node(
  cwd: string,
  artifacts: string,
  inputs: Record<string, unknown>,
  base = 'release/testing'
): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, script], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: '',
      ARTIFACTS_DIR: artifacts,
      BASE_BRANCH: base,
      ...Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [
          `INPUTS_${key.toUpperCase()}`,
          typeof value === 'string' ? value : JSON.stringify(value),
        ])
      ),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout);
}
async function checkout(): Promise<{ cwd: string; artifacts: string; root: string }> {
  const root = await temporary();
  const cwd = join(root, 'checkout');
  const artifacts = join(root, 'artifacts');
  await mkdir(cwd);
  await mkdir(artifacts);
  for (const args of [
    ['init', '-b', 'release/testing'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
  ]) {
    const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
  }
  return { cwd, artifacts, root };
}
test('real script nodes run a trusted check on a non-main base and collect revision-bound evidence', async () => {
  const { cwd, artifacts, root } = await checkout();
  const check = join(root, 'check.ts');
  await writeFile(
    check,
    `await Bun.write(process.env.REGRESS_EVIDENCE_PATH, JSON.stringify({
    revision: process.env.REGRESS_REVISION, base: process.env.REGRESS_BASE, base_revision: process.env.REGRESS_BASE_REVISION,
    scope: process.env.REGRESS_SCOPE, status: 'clean', public_cases: [] }));`
  );
  const policy = join(root, 'policy.json');
  await writeFile(
    policy,
    JSON.stringify({ version: 1, argv: [process.execPath, check], timeout_seconds: 30 })
  );
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: 'parser', policy });
  expect(prepared.ready).toBe(true);
  expect(prepared.base).toBe('release/testing');
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy });
  expect(fixed.status).toBe('clean');
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    fixed,
    validation: null,
  });
  const finished = await node(cwd, artifacts, {
    phase: 'finish',
    prepared,
    evidence: collected,
    diagnosis: clean,
    investigation: null,
    publish: false,
  });
  expect(finished.status).toBe('clean');
  expect(finished.publication).toBe('disabled');
  expect(JSON.parse(await readFile(join(artifacts, 'regress/result.json'), 'utf8'))).toEqual(
    finished
  );
});
test('real nodes reject checkout-local policy and missing tools without claiming a defect', async () => {
  const { cwd, artifacts, root } = await checkout();
  const policy = join(cwd, 'policy.json');
  const value = JSON.stringify({
    version: 1,
    argv: ['archon-regress-nonexistent-tool'],
    timeout_seconds: 1,
  });
  await writeFile(policy, value);
  const rejected = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy });
  expect(rejected.ready).toBe(false);
  const external = join(root, 'external.json');
  await writeFile(external, value);
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy: external });
  const fixed = await node(cwd, artifacts, { phase: 'configured', prepared, policy: external });
  expect(fixed.status).toBe('inconclusive');
});
test('real ordinary collector rejects absent and stale artifacts and final gate rejects replaced evidence', async () => {
  const { cwd, artifacts } = await checkout();
  const prepared = await node(cwd, artifacts, { phase: 'prepare', scope: '', policy: '' });
  const validation = { green: true, red_cause: '', summary: 'Gate passed.' };
  const inputs = { phase: 'collect', prepared, validation, fixed: null };
  expect((await node(cwd, artifacts, inputs)).status).toBe('inconclusive');
  const report = join(artifacts, 'validation.md');
  await writeFile(report, 'project check: exit 0');
  await utimes(report, new Date(0), new Date(0));
  expect((await node(cwd, artifacts, inputs)).status).toBe('inconclusive');
  await writeFile(report, 'project check: exit 0');
  const collected = await node(cwd, artifacts, inputs);
  expect(collected.status).toBe('clean');
  await writeFile(String(collected.report), 'replaced evidence');
  const finished = await node(cwd, artifacts, {
    phase: 'finish',
    prepared,
    evidence: collected,
    diagnosis: clean,
    investigation: null,
    publish: true,
  });
  expect(finished.status).toBe('inconclusive');
  expect(finished.publication).toBe('not-applicable');
});
test('an unresolved base retains the concrete preparation failure in the returned result', async () => {
  const { cwd, artifacts } = await checkout();
  const prepared = await node(
    cwd,
    artifacts,
    { phase: 'prepare', scope: '', policy: '' },
    'absent-base'
  );
  expect(prepared.ready).toBe(false);
  const collected = await node(cwd, artifacts, {
    phase: 'collect',
    prepared,
    validation: null,
    fixed: null,
  });
  const finished = await node(cwd, artifacts, {
    phase: 'finish',
    prepared,
    evidence: collected,
    diagnosis: { status: 'inconclusive', summary: 'Base unavailable', findings: [] },
    investigation: null,
    publish: true,
  });
  expect(finished.status).toBe('inconclusive');
  expect(finished.summary).toBe(prepared.reason);
  expect(finished.publication).toBe('not-applicable');
});

test('diagnosis schema conforms to the typed consumer, including every status and finding field', async () => {
  const workflow = object(
    Bun.YAML.parse(await readFile(resolve(import.meta.dir, '../archon-regress.yaml'), 'utf8'))
  );
  const nodes = workflow.nodes;
  if (!Array.isArray(nodes)) throw new Error('Missing workflow nodes');
  const schema = object(
    object(nodes.find((value: unknown) => object(value).id === 'diagnose')).output_format
  );
  function conforms(value: unknown, format: unknown): void {
    const shape = object(format);
    if (Array.isArray(value)) {
      expect(shape.type).toBe('array');
      value.forEach((item: unknown) => conforms(item, shape.items));
    } else if (typeof value === 'object' && value !== null) {
      const properties = object(shape.properties);
      const fields = object(value);
      expect(shape.type).toBe('object');
      expect(Object.keys(properties).sort()).toEqual(Object.keys(fields).sort());
      expect(shape.required).toEqual(expect.arrayContaining(Object.keys(fields)));
      for (const [key, item] of Object.entries(fields)) conforms(item, properties[key]);
    } else expect(shape.type).toBe(typeof value);
  }
  const variants: Record<Diagnosis['status'], Diagnosis> = {
    clean,
    defects: diagnosis,
    inconclusive: { status: 'inconclusive', summary: 'Missing evidence', findings: [] },
  };
  expect(object(object(schema.properties).status).enum).toEqual(Object.keys(variants));
  for (const variant of Object.values(variants)) {
    conforms(variant, schema);
    expect(readDiagnosis(variant)).toEqual(variant);
  }
});

test('CLI composes regress and delivers its structured return to a real deterministic consumer', async () => {
  const root = await temporary();
  const workflows = join(root, '.archon/workflows');
  await mkdir(workflows, { recursive: true });
  await writeFile(
    join(workflows, 'regress-composition.yaml'),
    `
name: regress-composition
description: Test the included regression contract without agents or publication.
returns: result
nodes:
  - id: regression
    include: archon-regress
    with: { scope: parser, policy: '', publish: false }
  - id: result
    script: |
      const result = JSON.parse(process.env.INPUTS_RESULT);
      if (result.status !== 'clean' || result.publication !== 'disabled') throw new Error('Unexpected included result');
      console.log(JSON.stringify(result));
    runtime: bun
    depends_on: [regression]
    with: { result: '$regression.output' }
`
  );
  const stubs = join(root, 'stubs.yaml');
  await writeFile(
    stubs,
    `
regression__prepare: { ready: true, mode: discovered }
regression__validation__validate: { green: true, red_cause: '', summary: 'Checks passed.' }
regression__collect: { status: clean }
regression__diagnose: { status: clean, summary: 'Checks passed.', findings: [] }
regression__finish: { status: clean, publication: disabled, issues: [] }
`
  );
  const cli = resolve(import.meta.dir, '../../../../../packages/cli/src/cli.ts');
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      'workflow',
      'run',
      'regress-composition',
      '--cwd',
      root,
      '--dry-run',
      '--exec-code',
      '--stubs',
      stubs,
      '--json',
    ],
    {
      env: { ...process.env, DATABASE_URL: '', ARCHON_HOME: join(root, 'home') },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Composition failed: ${stdout}\n${stderr}`);
  expect(JSON.parse(stdout).outcome).toBe('completed');
});
