/**
 * The SDLC pack's outputs, read on the engine's terms. The pack may not import engine code,
 * so its tests cannot ask the engine whether a script's stdout passes the node's declared
 * `output_format`, or whether a value the pack restates (a status set, a tier name, a node
 * id the engine derives) still matches. These tests run the pack's scripts and parse its
 * workflows, then judge the result with the engine's own validator, schemas and naming.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { nodeCostScope } from '../packages/workflows/src/node-record-serialization';
import { EFFORT_LEVELS } from '../packages/workflows/src/schemas/effort';
import {
  type ModelAliasPreset,
  modelAliasPresetSchema,
  TIER_NAMES,
} from '../packages/workflows/src/schemas/model-binding';
import {
  executionBindingSchema,
  executionSpendSchema,
  nodeExecutionMetadataSchema,
  unavailableMeasurementSchema,
} from '../packages/workflows/src/schemas/node-execution';
import {
  TERMINAL_WORKFLOW_STATUSES,
  workflowRunStatusSchema,
} from '../packages/workflows/src/schemas/workflow-run';
import { validateStructuredOutput } from '../packages/workflows/src/structured-output';
import {
  gitCheckout,
  hostCli,
  PACK,
  PR,
  packScriptRunner,
  type ScriptRun,
} from '../.archon/scripts/__tests__/deliver-checks-harness';
import {
  agentBinding,
  artifactsOf,
  EFFORTS,
  reportsOwnSpend,
  spendOf,
  TIERS,
  type TierBinding,
} from '../.archon/workflows/sdlc/review-eval/scripts/runs';
import type { Closure } from '../.archon/workflows/sdlc/.shared/close';
import { type AgentDecision, AGENT_OUTCOMES } from '../.archon/workflows/sdlc/.shared/discoveries';
import { parseQualifiedPr } from '../.archon/workflows/sdlc/.shared/forge';
import { SIZE_LABEL, TYPE_LABEL } from '../.archon/workflows/sdlc/.shared/labels';
import { claimDisposition } from '../.archon/workflows/sdlc/.shared/state';
import { newWorkItem } from '../.archon/workflows/sdlc/.shared/workitem';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();
registerBuiltinProviders();

type Schema = Record<string, unknown>;

/** The `output_format` a pack workflow declares on one node, as the engine validates it. */
function outputFormat(workflow: string, nodeId: string): Schema {
  const parsed = Bun.YAML.parse(readFileSync(join(PACK, workflow), 'utf8')) as {
    nodes: { id: string; output_format?: Schema }[];
  };
  const schema = parsed.nodes.find(node => node.id === nodeId)?.output_format;
  if (schema === undefined) throw new Error(`${workflow} declares no output_format on ${nodeId}`);
  return schema;
}

/** A script that succeeded with output its node's declared schema admits. */
function admitted(run: ScriptRun, workflow: string, nodeId: string): Record<string, unknown> {
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });
  const output = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(validateStructuredOutput(output, outputFormat(workflow, nodeId))).toEqual({ valid: true });
  return output;
}

/** A checkout with its own state store, read and written through the host CLI. */
function install(prefix: string): { checkout: string; env: Record<string, string> } {
  const checkout = gitCheckout({}, track);
  const home = track(mkdtempSync(join(tmpdir(), prefix)));
  return {
    checkout,
    env: {
      ARCHON_HOME: home,
      HOME: home,
      DATABASE_URL: '',
      ARCHON_TELEMETRY_DISABLED: '1',
      INTAKE_STATE_CWD: checkout,
      INTAKE_HOST_CLI: JSON.stringify(hostCli()),
    },
  };
}

const FAKE_ARCHON = join(
  import.meta.dir,
  '../.archon/scripts/__tests__/fixtures/fake-archon-runs.ts'
);

test('blocked pickup emits identified items admitted by its workflow schema', () => {
  const at = install('archon-blocked-home-');
  const item = {
    ...newWorkItem({ repo: PR.repo, number: 8 }, '2026-10-16T00:00:00.000Z'),
    stage: 'blocked',
  };
  const seeded = Bun.spawnSync(
    [process.execPath, FAKE_ARCHON, 'state', 'put', 'work/8', '--if-revision', '0'],
    {
      cwd: at.checkout,
      env: { ...process.env, ...at.env },
      stdin: Buffer.from(JSON.stringify(item)),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  expect({ code: seeded.exitCode, stderr: seeded.stderr.toString() }).toEqual({
    code: 0,
    stderr: '',
  });
  const output = admitted(
    runPackScript('build-queue/scripts/blocked', {
      cwd: at.checkout,
      forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
      inputs: { ...at.env, INPUTS_NUMBER: '', INPUTS_RETRIAGE_AS: 'maintainer' },
    }),
    'build-queue/archon-build-queue.yaml',
    'blocked'
  );
  expect(output).toEqual({ blocked: [{ number: 8, summary: '' }], blocked_count: 1 });
  const schema = outputFormat('build-queue/archon-build-queue.yaml', 'blocked');
  for (const item of [
    {},
    { number: 8 },
    { summary: '' },
    { number: '8', summary: '' },
    { number: 0, summary: '' },
    { number: 8, summary: null },
  ]) {
    expect(validateStructuredOutput({ blocked: [item], blocked_count: 1 }, schema).valid).toBe(
      false
    );
  }
});

describe('triage', () => {
  const TRIAGE = 'triage/archon-triage-block.yaml';
  const DELIVERED: Closure = {
    kind: 'delivered',
    url: 'https://ghe.example.com/example/repo/pull/5',
  };

  test('a close verdict is output the verdict node admits', () => {
    const run = runPackScript('triage/scripts/verdict', {
      inputs: {
        INPUTS_ITEM: JSON.stringify({ repo: PR.repo, number: 7 }),
        INPUTS_PUBLISH: 'false',
        INPUTS_DECISION: JSON.stringify({ contract: 'NO_ACTION', closure: DELIVERED }),
        INPUTS_TYPE: '{"value":"feature","reason":"new behavior"}',
        INPUTS_SIZE: '{"value":"s","reason":"one script"}',
        INPUTS_COMPLEXITY: '{"value":"low","reason":"clear change"}',
        INPUTS_IMPORTANCE: '{"value":"medium","reason":"on direction"}',
        INPUTS_URGENCY: '{"value":"none","reason":"nothing waits on it"}',
        INPUTS_SUMMARY: 'Ready',
        INPUTS_AREA_LABELS: '["area","nonexistent"]',
        INPUTS_RELATED: '[]',
        INPUTS_REPORT: '{"type":"archon_artifact","run_id":"r","path":"triage.md"}',
      },
    });
    expect(admitted(run, TRIAGE, 'verdict').closure).toEqual(DELIVERED);
  });

  test('the verdict output admits exactly the closures the triage decision does', () => {
    const closure = (outputFormat(TRIAGE, 'verdict').properties as Record<string, Schema>).closure;
    const url = 'https://ghe.example.com/example/repo/issues/3';
    const allowed: (Closure | null)[] = [
      null,
      DELIVERED,
      { kind: 'duplicate', url, original: { repo: PR.repo, number: 3 } },
    ];
    for (const value of allowed) expect(validateStructuredOutput(value, closure).valid).toBe(true);
    for (const value of [{ kind: 'duplicate', url }, { kind: 'delivered' }, { url }]) {
      expect(validateStructuredOutput(value, closure).valid).toBe(false);
    }
  });

  const VALID = {
    decision: { contract: 'READY', route: 'deliver' },
    type: { value: 'bug', reason: 'a regression' },
    size: { value: 's', reason: 'one file' },
    complexity: { value: 'high', reason: 'touches authentication' },
    importance: { value: 'medium', reason: 'on direction' },
    urgency: { value: 'now', reason: 'blocks a release' },
    item: { repo: { host: '', path: '' }, number: 0 },
    area_labels: [],
    related: [],
    summary: 'Ready',
    report: { type: 'archon_artifact', run_id: 'r', path: 'triage.md' },
  };

  test('the triage schema requires the kind and URL on NO_ACTION, so the provider is re-asked', () => {
    const schema = outputFormat(TRIAGE, 'triage');
    const declared = (decision: unknown) =>
      validateStructuredOutput({ ...VALID, decision, item: { repo: PR.repo, number: 7 } }, schema)
        .valid;
    const original = { repo: PR.repo, number: 3 };
    const url = 'https://ghe.example.com/example/repo/issues/3';
    expect(declared({ contract: 'NO_ACTION', closure: DELIVERED })).toBe(true);
    expect(declared({ contract: 'NO_ACTION', closure: { kind: 'duplicate', url, original } })).toBe(
      true
    );
    for (const closure of [
      undefined,
      { url },
      { kind: 'delivered' },
      { kind: 'duplicate', url },
      { kind: 'obsolete', url },
    ]) {
      expect(declared({ contract: 'NO_ACTION', closure })).toBe(false);
    }
  });

  test('the triage producer declares qualified identities and its non-tracker sentinel', () => {
    const schema = (outputFormat(TRIAGE, 'triage').properties as Record<string, Schema>).item;
    const qualified = { repo: { host: 'tracker.example', path: 'group/team/repo' }, number: 7 };
    expect(validateStructuredOutput(qualified, schema).valid).toBe(true);
    expect(
      validateStructuredOutput({ repo: { host: '', path: '' }, number: 0 }, schema).valid
    ).toBe(true);
    expect(validateStructuredOutput({ repository: 'owner/repo', number: 7 }, schema).valid).toBe(
      false
    );
    expect(
      validateStructuredOutput({ repo: { path: 'group/team/repo' }, number: 7 }, schema).valid
    ).toBe(false);
    // Half-qualified or mismatched pairings are re-asked at the node, never refused later.
    for (const illegal of [
      { repo: { host: '', path: 'group/team/repo' }, number: 7 },
      { repo: { host: 'tracker.example', path: 'group/team/repo' }, number: 0 },
      { repo: { host: '', path: '' }, number: 7 },
      { repo: { host: ' ', path: 'group/team/repo' }, number: 7 },
    ]) {
      expect(validateStructuredOutput(illegal, schema).valid).toBe(false);
    }
  });

  test('triage requires its five judged fields, each a listed value and a non-empty reason', () => {
    const schema = outputFormat(TRIAGE, 'triage');
    expect(validateStructuredOutput(VALID, schema).valid).toBe(true);
    // An invalid output is what the engine re-asks the provider on.
    for (const field of ['type', 'size', 'complexity', 'importance', 'urgency'] as const) {
      const { [field]: judged, ...missing } = VALID;
      expect(validateStructuredOutput(missing, schema).valid).toBe(false);
      for (const broken of [
        { value: judged.value },
        { value: judged.value, reason: ' ' },
        { value: 'small', reason: 'retired value' },
      ]) {
        expect(validateStructuredOutput({ ...VALID, [field]: broken }, schema).valid).toBe(false);
      }
    }
    // The labels mirror type and size, so the schema's values and the label map's keys
    // must be the same set.
    const properties = schema.properties as Record<
      string,
      { properties: { value: { enum: string[] } } }
    >;
    expect([...properties.type.properties.value.enum].sort()).toEqual(
      Object.keys(TYPE_LABEL).sort()
    );
    expect([...properties.size.properties.value.enum].sort()).toEqual(
      Object.keys(SIZE_LABEL).sort()
    );
  });
});

// archon-review's scope node declares the pull request that publish-review then hands to
// parseQualifiedPr. A value the schema admits but the parser refuses passes the provider's
// structured output and fails publication after the whole review ran.
test("archon-review's scope pr schema admits exactly what parseQualifiedPr accepts", () => {
  const schema = outputFormat('review/archon-review-block.yaml', 'scope');
  const repo = { host: 'github.com', path: 'coleam00/Archon' };
  const report = { type: 'archon_artifact', run_id: 'run', path: 'review/scope.md' };
  const candidates = [
    { repo, number: 1 },
    { repo, number: 0 },
    { repo, number: -3 },
    { repo: { ...repo, host: '' }, number: 1 },
    { repo: { ...repo, host: '  ' }, number: 1 },
    { repo: { ...repo, path: '' }, number: 1 },
    { repo: { ...repo, path: '\t' }, number: 1 },
  ];
  const verdicts = candidates.map(pr => {
    let parserAccepts = true;
    try {
      parseQualifiedPr(JSON.stringify(pr));
    } catch {
      parserAccepts = false;
    }
    return {
      parserAccepts,
      schemaAccepts: validateStructuredOutput({ head_matches: true, pr, report }, schema).valid,
    };
  });
  expect(verdicts.map(v => v.schemaAccepts)).toEqual(verdicts.map(v => v.parserAccepts));
  // Guard against a vacuous match: the parser must accept the qualified PR.
  expect(verdicts[0]?.parserAccepts).toBe(true);
});

describe('intake', () => {
  test("a claim is released only when its run's status is one the engine calls terminal", () => {
    for (const status of workflowRunStatusSchema.options)
      expect(claimDisposition(status)).toBe(
        TERMINAL_WORKFLOW_STATUSES.includes(status) ? 'release' : 'hold'
      );
    expect(claimDisposition(null)).toBe('hold');
  });
});

describe('discoveries', () => {
  const DISCOVERIES = 'discoveries/archon-discoveries.yaml';
  const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';
  const ISSUE = { repo: PR.repo, number: 7 };

  test("the decide node's output schema admits each of the agent's outcomes", () => {
    const schema = outputFormat(DISCOVERIES, 'decide');
    const base = { key: 'some-defect', refs: [`${RUN}:review#0`], title: 'A defect' };
    const examples: AgentDecision[] = [
      { ...base, outcome: 'file', body: 'The brief.', reason: 'r' },
      { ...base, outcome: 'track', issue: ISSUE, comment: null, reason: 'r' },
      { ...base, outcome: 'track', issue: ISSUE, comment: 'More evidence.', reason: 'r' },
      { ...base, outcome: 'drop', reason: 'r' },
      { ...base, outcome: 'ask', question: 'q', recommendation: 'r' },
    ];
    expect(new Set(examples.map(example => example.outcome))).toEqual(new Set(AGENT_OUTCOMES));
    for (const example of examples) {
      expect(validateStructuredOutput({ decisions: [example], summary: 's' }, schema)).toEqual({
        valid: true,
      });
    }
    expect(
      validateStructuredOutput(
        { decisions: [{ ...base, outcome: 'drop', body: 'b', reason: 'r' }], summary: 's' },
        schema
      ).valid
    ).toBe(false);
  });

  test('a pass emits facts, an outcome and an answer their nodes admit', () => {
    const at = install('archon-discoveries-home-');
    const outputRoot = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-runs-')));
    const artifacts = join(outputRoot, 'artifacts', 'runs', RUN);
    mkdirSync(join(artifacts, 'nodes'), { recursive: true });
    const record = (title: string) => ({
      title,
      claim: `${title}, claimed`,
      evidence: ['a.ts:1'],
      relation: 'unrelated',
      source_nodes: ['implement'],
    });
    writeFileSync(
      join(artifacts, 'nodes/review.md'),
      JSON.stringify({
        ready: true,
        discoveries: ['new', 'covered', 'fixed', 'unclear'].map(record),
      })
    );
    writeFileSync(
      join(artifacts, 'nodes/review.meta.json'),
      JSON.stringify({
        nodeId: 'review',
        outputType: 'review-report',
        path: 'nodes/review.md',
        runId: RUN,
        producedAt: '2026-10-14T01:00:00.000Z',
        size: 1,
      })
    );
    const script = (
      name: 'facts' | 'outcome' | 'answer',
      runs: string[],
      inputs: Record<string, string> = {},
      files: Record<string, string> = {}
    ): ScriptRun =>
      runPackScript(`discoveries/scripts/${name}`, {
        cwd: at.checkout,
        forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
        gh: { issue: { number: 7, state: 'open' }, issues: [] },
        artifacts: files,
        inputs: {
          ...at.env,
          WORKFLOW_ID: 'pass-1',
          INTAKE_RUN_STATUSES: '{}',
          RUN_LISTING: JSON.stringify(
            runs.map(id => ({
              id,
              workflow_name: 'archon-ship',
              status: 'completed',
              completed_at: '2026-10-14T03:00:00.000Z',
              output_root: outputRoot,
            }))
          ),
          INPUTS_REPO_HOST: PR.repo.host,
          INPUTS_REPO_PATH: PR.repo.path,
          INPUTS_SINCE: '',
          INPUTS_UNTIL: '',
          INPUTS_LIMIT: '20',
          ...inputs,
        },
      });

    const facts = script('facts', [RUN]);
    const output = admitted(facts, DISCOVERIES, 'facts');
    const queue = readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8');
    const refs = (JSON.parse(queue) as { runs: { records: { ref: string }[] }[] }).runs.flatMap(
      run => run.records.map(entry => entry.ref)
    );
    const decisions: AgentDecision[] = [
      {
        outcome: 'file',
        key: 'new-defect',
        refs: [refs[0] ?? ''],
        title: 'New',
        body: 'The brief.',
        reason: 'real',
      },
      {
        outcome: 'track',
        key: 'covered-defect',
        refs: [refs[1] ?? ''],
        title: 'Covered',
        issue: ISSUE,
        comment: 'More.',
        reason: 'covered',
      },
      {
        outcome: 'drop',
        key: 'fixed-defect',
        refs: [refs[2] ?? ''],
        title: 'Fixed',
        reason: 'fixed',
      },
      {
        outcome: 'ask',
        key: 'unclear-scope',
        refs: [refs[3] ?? ''],
        title: 'Unclear',
        question: 'In scope?',
        recommendation: 'Drop it.',
      },
    ];
    const outcome = admitted(
      script(
        'outcome',
        [RUN],
        {
          INPUTS_PATH: String(output.path),
          INPUTS_DECISIONS: JSON.stringify(decisions),
          INPUTS_SUMMARY: 'summary',
        },
        { 'drain/queue.json': queue }
      ),
      DISCOVERIES,
      'outcome'
    );
    expect(outcome.asked).toEqual(['unclear-scope']);
    admitted(
      script(
        'answer',
        [],
        { INPUTS_KEYS: '["unclear-scope"]', INPUTS_TEXT: 'Out of scope.' },
        { 'drain/queue.json': queue }
      ),
      DISCOVERIES,
      'answer'
    );
  }, 60_000);
});

describe('the review bench', () => {
  test('a version names every tier and effort the engine binds, in a shape its alias preset accepts', () => {
    expect([...TIERS]).toEqual([...TIER_NAMES]);
    expect([...EFFORTS]).toEqual([...EFFORT_LEVELS]);
    const binding: TierBinding = { provider: 'claude', model: 'opus', effort: 'high' };
    expect(modelAliasPresetSchema.parse(binding)).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });
    const fromEngine = (preset: ModelAliasPreset): TierBinding => preset;
    expect(fromEngine({ provider: 'codex', model: 'gpt' })).toEqual({
      provider: 'codex',
      model: 'gpt',
    });
  });

  const unmeasured = { source: 'unavailable', reason: 'not_reported' } as const;
  const spend = (fields: object) =>
    executionSpendSchema.parse({ stopReason: unmeasured, numTurns: unmeasured, ...fields });

  test('a row counts as own spend exactly when the engine says so, legacy roll-ups included', () => {
    const rows = [
      ...nodeExecutionMetadataSchema.shape.accounting.options.map(accounting => ({ accounting })),
      {},
      { aggregate: true },
      { aggregate: false },
    ];
    expect(rows.map(reportsOwnSpend)).toEqual(rows.map(row => nodeCostScope(row) === 'own'));
  });

  test('every unavailable reason, a floor cost and a resolved model read as the engine writes them', () => {
    for (const reason of unavailableMeasurementSchema.shape.reason.options) {
      const none = { source: 'unavailable', reason };
      const known = reason === 'not_applicable';
      expect(spendOf([spend({ tokens: none, costUsd: none })])).toEqual({
        cost_usd: known ? 0 : null,
        cost_partial: false,
        tokens: known ? { input: 0, output: 0 } : null,
      });
    }
    const floor = spend({
      tokens: { source: 'provider', value: { input: 3, output: 1, cacheRead: 2 } },
      costUsd: { source: 'provider', value: 1.5, partial: true },
    });
    expect(spendOf([floor])).toEqual({
      cost_usd: 1.5,
      cost_partial: true,
      tokens: { input: 3, output: 1 },
    });

    const binding = executionBindingSchema.parse({
      provider: 'claude',
      tier: 'large',
      effort: 'high',
      model: { requested: 'opus', resolved: { source: 'provider', value: 'claude-opus' } },
    });
    expect(
      agentBinding({
        nodeId: 'review__code',
        state: 'completed',
        kind: 'agent',
        binding,
        attempts: [],
      })
    ).toEqual({ provider: 'claude', tier: 'large', requested: 'opus', resolved: 'claude-opus' });
  });

  test('a run is read from the artifacts directory the engine writes', () => {
    const detail = { id: 'r1', output_root: '/home/me/.archon/workspaces/o/r' } as const;
    expect(
      artifactsOf({
        ...detail,
        status: 'completed',
        started_at: '',
        completed_at: null,
        base_branch: 'dev',
        aliases: {},
        nodes: [],
      })
    ).toBe(getRunArtifactsDirForRoot(detail.output_root, detail.id));
  });
});
