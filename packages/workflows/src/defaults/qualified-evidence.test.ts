import { expect, it, spyOn } from 'bun:test';
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { preparedSchema, qualificationResultSchema, runQualification } from './sdlc/qualification';
import type { MessageChunk } from '@archon/providers/types';
import { validateStructuredOutput } from '@archon/providers/structured-output';
import { parseWorkflow } from '../loader';
import { readToolCaptures, ToolCaptureSession } from '../tool-capture';
import {
  collectMergeFacts,
  createMergePlan,
  executeMergePlan,
  mergePlanDigest,
  type GitHubAdapter,
  type MergeMethod,
} from '../../../../.archon/workflows/sdlc/merge-queue/src/merge-queue';
import {
  evidenceReference,
  inspectQualifications,
  prepareQualification,
  prepareOrdinaryQualification,
  qualificationDecisionSchema,
  sealQualification,
  runtimeResultSchema,
} from './sdlc/qualified-evidence';

const track = trackTempRoots();
const url = 'https://github.com/owner/repo/pull/42';
const packRoot = join(import.meta.dir, '../../../../.archon/workflows/sdlc');

async function assertWorkflowOutput(pack: string, id: string, value: unknown) {
  const path = join(packRoot, pack, `archon-${pack}.yaml`);
  const parsed = parseWorkflow(await readFile(path, 'utf8'), path);
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  const node = parsed.workflow.nodes.find(node => node.id === id);
  if (node === undefined || !('output_format' in node) || node.output_format === undefined)
    throw new Error(`output schema missing for ${pack}/${id}`);
  expect(
    validateStructuredOutput(value, node.output_format, error => {
      throw new Error(error);
    }).valid
  ).toBe(true);
}

class GitHubFixture implements GitHubAdapter {
  merges: string[] = [];
  base = 'b'.repeat(40);
  review = 'independent review ready';
  collections = 0;
  beforeCollection?: (count: number) => Promise<void>;
  constructor(public head: string) {}
  async api(endpoint: string): Promise<unknown> {
    if (endpoint === 'repos/owner/repo') {
      await this.beforeCollection?.(++this.collections);
      return { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true };
    }
    if (endpoint === 'repos/owner/repo/pulls/42')
      return {
        state: this.merges.length ? 'closed' : 'open',
        draft: false,
        mergeable: true,
        merged_at: this.merges.length ? '2026-09-13T00:00:00Z' : null,
        auto_merge: null,
        review_decision: 'APPROVED',
        head: { sha: this.head, repo: { full_name: 'owner/repo' } },
        base: { ref: 'dev' },
      };
    if (endpoint === 'repos/owner/repo/branches/dev')
      return { protected: false, commit: { sha: this.base } };
    if (endpoint.includes('/rules/branches/')) return [];
    if (endpoint.includes('/check-runs')) return { check_runs: [] };
    if (endpoint.includes('/reviews') || endpoint.includes('/issues/42/comments'))
      return [{ id: 1, body: this.review }];
    if (endpoint.includes('/statuses') || endpoint.includes('/pulls/42/comments')) return [];
    throw new Error(`unexpected fixture endpoint ${endpoint}`);
  }
  async graphql(): Promise<unknown> {
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    };
  }
  async checkoutRepository(): Promise<string> {
    return 'owner/repo';
  }
  async merge(
    repository: string,
    number: number,
    method: MergeMethod,
    head: string
  ): Promise<void> {
    expect([repository, number, method, head]).toEqual(['owner/repo', 42, 'merge', this.head]);
    this.merges.push(head);
  }
}

async function fixture() {
  const root = track(await mkdtemp(join(tmpdir(), 'qualified-evidence-')));
  const checkout = join(root, 'repo');
  const artifacts = join(root, 'artifacts');
  await mkdir(checkout);
  await mkdir(artifacts);
  function git(...args: string[]): string {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: checkout,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  await writeFile(join(checkout, 'source.txt'), 'original source');
  git('add', 'source.txt');
  git('commit', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const github = new GitHubFixture(head);
  const expected = {
    scope: '',
    context: 'fixture-context',
    scenario: join(root, 'scenario.json'),
    holdout: join(root, 'holdout.json'),
  };
  for (const scenario of [expected.scenario, expected.holdout])
    await writeFile(scenario, JSON.stringify({ assertions: [{ id: 'zero', expected: false }] }));
  const validator = join(root, 'validator/scripts/validation-evidence.ts');
  for (const path of [
    'scripts/validation-evidence.ts',
    'commands/validate.md',
    'archon-validate.yaml',
  ]) {
    const destination = join(root, 'validator', path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(packRoot, 'validate', path), destination);
  }
  let producerStarts = 0;
  async function run(script: string, inputs: Record<string, string>): Promise<unknown> {
    producerStarts++;
    const child = Bun.spawn([process.execPath, script], {
      cwd: checkout,
      env: { ...process.env, ARTIFACTS_DIR: artifacts, WORKFLOW_ID: 'run', ...inputs },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr);
    return JSON.parse(stdout) as unknown;
  }
  const applicability = await run(validator, {
    INPUTS_ACTION: 'check',
    INPUTS_SCOPE: expected.scope,
    INPUTS_CONTEXT: expected.context,
  });
  await writeFile(join(artifacts, 'validation.md'), 'Project checks ran and passed.');
  await run(validator, {
    INPUTS_ACTION: 'record',
    INPUTS_APPLICABILITY: JSON.stringify(applicability),
    INPUTS_VERDICT: JSON.stringify({
      green: true,
      checks_performed: true,
      red_cause: '',
      summary: 'passed',
    }),
  });
  await mkdir(join(artifacts, 'review'));
  await writeFile(join(artifacts, 'review/report.md'), `Independent review ready at ${head}`);
  async function runtime(role: string, scenario: string, outcome: 'passed' | 'failed' = 'passed') {
    const target = `factory-v1:${(role === 'runtime' ? 'a' : 'b').repeat(64)}`;
    const directory = join(artifacts, role);
    const capture = await ToolCaptureSession.create(
      artifacts,
      join(directory, 'captures'),
      'run',
      role,
      1
    );
    async function* events(): AsyncGenerator<MessageChunk> {
      yield { type: 'tool', toolName: 'probe', toolCallId: 'call' };
      yield {
        type: 'tool_result',
        toolName: 'probe',
        toolCallId: 'call',
        toolOutput: 'display',
        toolOutcome: 'error',
        exitCode: 1,
        capture: {
          text: JSON.stringify({
            candidate: target,
            source_revision: head,
            observed: outcome === 'failed',
            count: outcome === 'failed' ? 1 : 0,
          }),
          format: 'json',
          completeness: 'full',
          attachments: [],
        },
      };
      yield { type: 'result' };
    }
    for await (const message of capture.retain(events(), [])) void message;
    const reportPath = join(directory, 'report.json');
    await writeFile(join(directory, 'target.txt'), target);
    await writeFile(
      reportPath,
      JSON.stringify({
        candidate: target,
        assertions: [
          {
            id: 'zero',
            outcome,
            expected: { value: false, source_revision: head },
            observed: { value: outcome === 'failed', source_revision: head },
            reason: 'zero observed on described source revision',
            evidence: [{ call_id: 'call' }],
          },
        ],
      })
    );
    await cp(join(packRoot, 'verify-runtime'), join(directory, 'evaluator'), { recursive: true });
    const evaluator = join(directory, 'evaluator/scripts/check-evidence.js');
    const assessed = await run(evaluator, {
      INPUTS_DIRECTORY: directory,
      INPUTS_REPORT_PATH: reportPath,
      INPUTS_REQUIRED_IDS: '["zero"]',
      INPUTS_EXPECTED_CANDIDATE: '',
      INPUTS_START_OK: 'true',
      INPUTS_IDENTITY_OK: 'true',
      INPUTS_SCENARIO: scenario,
    });
    if (
      assessed === null ||
      typeof assessed !== 'object' ||
      !('status' in assessed) ||
      assessed.status !== (outcome === 'passed' ? 'verified' : 'failed') ||
      !('evidence' in assessed)
    )
      throw new Error('invalid checker output');
    return runtimeResultSchema.parse({
      candidate: target,
      evidence: assessed.evidence,
      verified: outcome === 'passed',
      verdict: outcome === 'passed' ? 'verified' : 'failed',
      checkout: head,
      summary: 'passed',
    });
  }
  const runtimeResult = await runtime('runtime', expected.scenario);
  const holdoutResult = await runtime('holdout', expected.holdout);
  const evaluator = join(root, 'qualifier.js');
  await copyFile(join(packRoot, 'lifecycle/scripts/qualification.js'), evaluator);
  const facts = await collectMergeFacts([url], github);
  const prepare = () =>
    prepareQualification({
      checkout,
      runId: 'run',
      artifactsDir: artifacts,
      expected,
      facts,
      runtime: runtimeResult,
      holdout: holdoutResult,
      evaluator: [evaluator],
    });
  const bundle = await prepare();
  const decisionPath = join(artifacts, 'qualification.md');
  await writeFile(
    decisionPath,
    'Compared actual false/zero probe output against both scenarios; independent review and holdout qualify.'
  );
  const decision = qualificationDecisionSchema.parse({
    ready: true,
    repair: false,
    summary: 'qualified',
    evidence: decisionPath,
    supporting_evidence: [],
    holds: [],
    method: 'merge',
    method_source: 'caller',
    method_conflict: '',
  });
  const reference = await sealQualification(
    bundle,
    decision,
    expected,
    facts,
    join(artifacts, 'qualified.json')
  );
  const assessment = await inspectQualifications([reference], expected, facts);
  expect(assessment.ready).toBe(true);
  const plan = createMergePlan(facts, assessment, 'merge', {
    references: [reference],
    requirements: expected,
  }).plan;
  if (plan === undefined) throw new Error('qualification did not produce a plan');
  return {
    root,
    checkout,
    artifacts,
    head,
    github,
    expected,
    facts,
    bundle,
    decision,
    reference,
    plan,
    evaluator,
    runtimeResult,
    holdoutResult,
    prepare,
    runtime,
    producerStarts: () => producerStarts,
  };
}

it('hands actual producer receipts to merge and reuses them after unchanged approval', async () => {
  const value = await fixture();
  expect(value.runtimeResult.candidate).not.toBe(value.head);
  expect(value.holdoutResult.candidate).not.toBe(value.runtimeResult.candidate);
  const starts = value.producerStarts();
  expect((await executeMergePlan(value.plan, 'preview', null, value.github)).merged).toBe(false);
  expect(value.github.merges).toEqual([]);
  expect(
    (
      await executeMergePlan(
        value.plan,
        'approve',
        { decision: 'approve' },
        value.github,
        mergePlanDigest(value.plan)
      )
    ).merged
  ).toBe(true);
  expect(value.github.merges).toEqual([value.head]);
  expect(value.producerStarts()).toBe(starts);
});

it('qualifies a standalone ordinary report without runtime roles and protects the evidence it used', async () => {
  const value = await fixture();
  const expected = { scope: 'docs', context: 'ordinary', scenario: '', holdout: '' };
  const report = join(value.root, 'external.md');
  await writeFile(
    report,
    `Checks and independent review for ${url} at ${value.head} against ${value.github.base}.`
  );
  const supporting = join(value.root, 'checks.txt');
  await writeFile(supporting, 'actual ordinary check output');
  const bundle = await prepareOrdinaryQualification({
    checkout: value.checkout,
    runId: 'standalone-run',
    expected,
    facts: value.facts,
    report,
    evaluator: [value.evaluator],
  });
  expect(bundle.roles.kind).toBe('ordinary');
  const decision = {
    ...value.decision,
    supporting_evidence: [await evidenceReference(supporting)],
  };
  const reference = await sealQualification(
    bundle,
    decision,
    expected,
    value.facts,
    join(value.root, 'ordinary-qualified.json')
  );
  const assessment = await inspectQualifications([reference], expected, value.facts);
  const planned = createMergePlan(value.facts, assessment, 'merge', {
    references: [reference],
    requirements: expected,
  });
  if (planned.plan === undefined) throw new Error('ordinary evidence did not qualify');
  expect((await inspectQualifications([reference], value.expected, value.facts)).ready).toBe(false);
  await writeFile(supporting, 'changed ordinary check output');
  expect((await executeMergePlan(planned.plan, 'auto', null, value.github)).merged).toBe(false);
  await writeFile(supporting, 'actual ordinary check output');
  expect(
    (await executeMergePlan(planned.plan, 'approve', { decision: 'approve' }, value.github)).merged
  ).toBe(true);
});

it('runs packaged standalone preparation, semantic sealing and qualified reuse without a lifecycle', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'ordinary-qualification-')));
  const checkout = join(root, 'repo');
  const artifacts = join(root, 'artifacts');
  await mkdir(checkout);
  await mkdir(artifacts);
  for (const args of [
    ['init', '-q'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
  ]) {
    const git = Bun.spawnSync(['git', ...args], { cwd: checkout, stdout: 'pipe', stderr: 'pipe' });
    expect(git.exitCode).toBe(0);
  }
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: checkout })
    .stdout.toString()
    .trim();
  const github = new GitHubFixture(head);
  const facts = await collectMergeFacts([url], github);
  const pack = join(root, 'merge-queue');
  await cp(join(packRoot, 'merge-queue'), pack, { recursive: true });
  const script = join(pack, 'scripts/qualification.js');
  const externalReport = join(root, 'ordinary.md');
  await writeFile(externalReport, `Ordinary checks and independent review for ${url} at ${head}.`);
  const env = {
    ARTIFACTS_DIR: artifacts,
    WORKFLOW_ID: 'ordinary-run',
    INPUTS_SCOPE: '',
    INPUTS_CONTEXT: '',
    INPUTS_RUNTIME_SCENARIO: '',
    INPUTS_HOLDOUT_SCENARIO: '',
  };
  const child = Bun.spawn([process.execPath, script], {
    cwd: checkout,
    env: {
      ...process.env,
      ...env,
      INPUTS_ACTION: 'prepare-merge',
      INPUTS_EVIDENCE: externalReport,
      INPUTS_FACTS: JSON.stringify(facts),
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
  const prepared = preparedSchema.parse(JSON.parse(stdout));
  await assertWorkflowOutput('merge-queue', 'qualification-input', prepared);
  expect(prepared.available).toBe(true);
  expect(prepared.summary).toBe('ordinary evidence ready for semantic qualification');
  await writeFile(
    prepared.report_path,
    `Independent semantic qualification accepts ordinary evidence at ${head}.`
  );
  const decision = {
    ready: true,
    repair: false,
    evidence: prepared.report_path,
    summary: 'ordinary evidence qualifies',
    supporting_evidence: [],
    method: 'merge',
    method_source: 'caller',
    method_conflict: '',
    holds: [],
  };
  const previousCwd = process.cwd();
  async function invoke(inputs: Record<string, string>) {
    const values = { ...env, ...inputs };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      Object.assign(process.env, values);
      process.chdir(checkout);
      await runQualification(github, script);
      expect(output).toHaveBeenCalledTimes(1);
      return JSON.parse(String(output.mock.calls[0]?.[0])) as unknown;
    } finally {
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      output.mockRestore();
    }
  }
  const sealInputs = {
    INPUTS_ACTION: 'seal',
    INPUTS_PREPARED: JSON.stringify(prepared),
    INPUTS_DECISION: JSON.stringify(decision),
  };
  const rejected = qualificationResultSchema.parse(
    await invoke({
      ...sealInputs,
      INPUTS_DECISION: JSON.stringify({
        ...decision,
        ready: false,
        summary: 'report observations do not establish the claimed behavior',
        holds: [{ kind: 'evidence', reason: 'irrelevant captured observation' }],
      }),
    })
  );
  expect(rejected).toMatchObject({
    ready: false,
    repair: false,
    references: [],
    holds: [{ kind: 'evidence', reason: 'irrelevant captured observation' }],
  });
  const sealed = qualificationResultSchema.parse(await invoke(sealInputs));
  await assertWorkflowOutput('merge-queue', 'qualified', sealed);
  expect(sealed.ready).toBe(true);
  const reuse = preparedSchema.parse(
    await invoke({
      INPUTS_ACTION: 'prepare-merge',
      INPUTS_EVIDENCE: JSON.stringify(sealed.references),
    })
  );
  expect(reuse.available).toBe(false);
  const selected = qualificationResultSchema.parse(
    await invoke({ INPUTS_ACTION: 'seal', INPUTS_PREPARED: JSON.stringify(reuse) })
  );
  expect(selected.references).toEqual(sealed.references);
  const expected = { scope: '', context: '', scenario: '', holdout: '' };
  const assessment = await inspectQualifications(selected.references, expected, facts);
  const plan = createMergePlan(facts, assessment, 'merge', {
    references: selected.references,
    requirements: expected,
  }).plan;
  if (plan === undefined)
    throw new Error('packaged ordinary evidence did not produce a merge plan');
  await writeFile(externalReport, 'changed evidence during approval');
  expect((await executeMergePlan(plan, 'approve', { decision: 'approve' }, github)).merged).toBe(
    false
  );
  expect(github.merges).toEqual([]);
  expect(qualificationResultSchema.parse(await invoke(sealInputs)).ready).toBe(false);
});

it('invalidates changed source, scenarios, evaluators, reports, captures and review bytes', async () => {
  const value = await fixture();
  const capture = (await readToolCaptures(value.runtimeResult.evidence.capture_directory, 'run'))
    .receipts[0]!.receipt;
  const files = [
    join(value.checkout, 'source.txt'),
    value.expected.scenario,
    value.expected.holdout,
    value.evaluator,
    value.runtimeResult.evidence.evaluator_path,
    value.runtimeResult.evidence.report_path,
    ...value.runtimeResult.evidence.evaluator_sources.map(source => source.path),
    join(value.runtimeResult.evidence.capture_directory, capture.output.path),
    join(value.artifacts, 'review/report.md'),
    join(value.artifacts, 'validation.md'),
    value.decision.evidence,
    value.reference.path,
  ];
  for (const path of files) {
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from('\nchanged')]));
    const result = await executeMergePlan(value.plan, 'auto', null, value.github);
    expect(result.merged).toBe(false);
    expect(result.holds.some(hold => hold.kind === 'evidence')).toBe(true);
    await writeFile(path, bytes);
  }
  expect(value.github.merges).toEqual([]);
});

it('prepares and seals lifecycle receipts and authorizes repair only for captured product failure', async () => {
  const value = await fixture();
  const pack = join(value.root, 'lifecycle');
  await cp(join(packRoot, 'lifecycle'), pack, { recursive: true });
  const script = join(pack, 'scripts/qualification.js');
  const inputs = {
    ARTIFACTS_DIR: value.artifacts,
    WORKFLOW_ID: 'run',
    INPUTS_SCOPE: value.expected.scope,
    INPUTS_CONTEXT: value.expected.context,
    INPUTS_RUNTIME_SCENARIO: value.expected.scenario,
    INPUTS_HOLDOUT_SCENARIO: value.expected.holdout,
    INPUTS_ACTION: 'prepare',
    INPUTS_CANDIDATE: JSON.stringify({ delivered: true, prs: [url], head: value.head }),
    INPUTS_RUNTIME: JSON.stringify(value.runtimeResult),
    INPUTS_HOLDOUT: JSON.stringify(value.holdoutResult),
  };
  const previousCwd = process.cwd();
  const previous = { ...process.env };
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.chdir(value.checkout);
    Object.assign(process.env, inputs);
    await runQualification(value.github, script);
    const prepared = preparedSchema.parse(JSON.parse(String(output.mock.calls.at(-1)?.[0])));
    expect(prepared.summary).toBe('evidence ready for semantic qualification');
    await assertWorkflowOutput('lifecycle', 'qualification-input', prepared);
    await writeFile(
      prepared.report_path,
      'Both opaque targets describe the delivered source revision and their captured observations qualify.'
    );
    process.env.INPUTS_ACTION = 'seal';
    process.env.INPUTS_PREPARED = JSON.stringify(prepared);
    process.env.INPUTS_DECISION = JSON.stringify({
      ...value.decision,
      evidence: prepared.report_path,
    });
    await runQualification(value.github, script);
    const sealed = qualificationResultSchema.parse(
      JSON.parse(String(output.mock.calls.at(-1)?.[0]))
    );
    await assertWorkflowOutput('lifecycle', 'qualify', sealed);
    expect(sealed.ready).toBe(true);
    expect(
      (await inspectQualifications(sealed.references, value.expected, value.facts)).ready
    ).toBe(true);
    value.github.review = 'new review during semantic qualification';
    await runQualification(value.github, script);
    expect(
      qualificationResultSchema.parse(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).ready
    ).toBe(false);
    value.github.review = 'independent review ready';
    const failed = await value.runtime('failed-runtime', value.expected.scenario, 'failed');
    process.env.INPUTS_ACTION = 'prepare';
    process.env.INPUTS_RUNTIME = JSON.stringify(failed);
    process.env.INPUTS_HOLDOUT = 'null';
    await runQualification(value.github, script);
    const failureInput = preparedSchema.parse(JSON.parse(String(output.mock.calls.at(-1)?.[0])));
    await writeFile(
      failureInput.report_path,
      'Captured probe returned true/count=1 where this scenario requires false/count=0.'
    );
    process.env.INPUTS_ACTION = 'seal';
    process.env.INPUTS_PREPARED = JSON.stringify(failureInput);
    process.env.INPUTS_DECISION = JSON.stringify({
      ...value.decision,
      evidence: failureInput.report_path,
      ready: false,
      repair: true,
      holds: [{ kind: 'code', reason: 'probe violated the zero-count assertion' }],
    });
    await runQualification(value.github, script);
    expect(
      qualificationResultSchema.parse(JSON.parse(String(output.mock.calls.at(-1)?.[0])))
    ).toMatchObject({ ready: false, repair: true, references: [] });
    await writeFile(failed.evidence.report_path, '{}');
    await runQualification(value.github, script);
    expect(
      qualificationResultSchema.parse(JSON.parse(String(output.mock.calls.at(-1)?.[0])))
    ).toMatchObject({ ready: false, repair: false, references: [] });
    expect(value.github.merges).toEqual([]);
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    output.mockRestore();
  }
});

it('invalidates current scope/context, candidate/base and GitHub review changes', async () => {
  const value = await fixture();
  expect(
    (
      await executeMergePlan(
        value.plan,
        'auto',
        null,
        value.github,
        mergePlanDigest(value.plan),
        undefined,
        value.expected,
        'squash'
      )
    ).merged
  ).toBe(false);
  for (const expected of [
    { ...value.expected, scope: 'other' },
    { ...value.expected, context: 'other' },
  ]) {
    expect(
      (
        await executeMergePlan(
          value.plan,
          'auto',
          null,
          value.github,
          mergePlanDigest(value.plan),
          undefined,
          expected
        )
      ).merged
    ).toBe(false);
  }
  for (const field of ['head', 'base', 'review'] as const) {
    const prior = value.github[field];
    value.github[field] = field === 'review' ? 'new blocking review' : 'c'.repeat(40);
    expect((await executeMergePlan(value.plan, 'auto', null, value.github)).merged).toBe(false);
    value.github[field] = prior;
  }
  expect(value.github.merges).toEqual([]);
});

it('checks capture integrity again immediately before the merge write', async () => {
  const value = await fixture();
  const initialCollections = value.github.collections;
  value.github.beforeCollection = async count => {
    if (count === initialCollections + 2)
      await writeFile(value.runtimeResult.evidence.report_path, '{}');
  };
  expect((await executeMergePlan(value.plan, 'auto', null, value.github)).merged).toBe(false);
  expect(value.github.merges).toEqual([]);
});

it('requires fresh holdout roles and does not seal semantic rejection or raw ready claims', async () => {
  const value = await fixture();
  value.holdoutResult.evidence.producer.nodeId = value.runtimeResult.evidence.producer.nodeId;
  await expect(value.prepare()).rejects.toThrow('distinct fresh producer');
  const rejected = {
    ...value.decision,
    ready: false,
    summary: 'captured output is unrelated to the target assertion',
    holds: [{ kind: 'evidence' as const, reason: 'irrelevant observation' }],
  };
  await expect(
    sealQualification(
      value.bundle,
      rejected,
      value.expected,
      value.facts,
      join(value.artifacts, 'rejected.json')
    )
  ).rejects.toThrow('not qualified');
  const raw = join(value.artifacts, 'raw-ready.json');
  await writeFile(raw, JSON.stringify({ ready: true, evidence: 'passed' }));
  expect(
    (await inspectQualifications([await evidenceReference(raw)], value.expected, value.facts)).ready
  ).toBe(false);
  expect(value.github.merges).toEqual([]);
});
