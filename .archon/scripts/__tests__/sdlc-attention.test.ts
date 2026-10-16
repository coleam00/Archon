import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { providerRegistry } from '@archon/providers';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import { makeTestComposedWorkflow } from '../../../packages/workflows/src/test-utils';
import { createFileWorkflowStore } from '../../../packages/workflows/src/file-store';
import { foldDagResumeSnapshot } from '../../../packages/workflows/src/dag-resume-snapshot';
import { executeDagWorkflow } from '../../../packages/workflows/src/dag-executor';
import { liveSourceRoots } from '../../../packages/workflows/src/workflow-source';
import { qualifyWorkflowResources } from '../../../packages/workflows/src/packaged-workflow';
import { discoverWorkflows } from '../../../packages/workflows/src/workflow-discovery';
import { pausedAttentionWait } from '../../../packages/workflows/src/schemas/workflow-run';
import type { WorkflowDefinition } from '../../../packages/workflows/src/schemas/workflow';
import { STAGE_EFFECTS, type Decision, type Stage } from '../../workflows/sdlc/.shared/standalone';
import { CONFIDENCES, type Attention, type Choice, type Recommendation } from '../../workflows/sdlc/.shared/queue';
import { record } from '../../workflows/sdlc/.shared/forge';
import { gitCheckout, packScriptRunner, PR } from './deliver-checks-harness';

registerBuiltinProviders();

const REPO = resolve(import.meta.dir, '../../..');
const PACK = join(REPO, '.archon/workflows/sdlc');
const track = trackTempRoots();
let testHome: string;
const priorHome = process.env.ARCHON_HOME;
beforeEach(() => {
  testHome = track(mkdtempSync(join(tmpdir(), 'sdlc-attention-home-')));
  process.env.ARCHON_HOME = testHome;
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = priorHome;
});
const { runPackScript } = packScriptRunner();
const STAGES = ['plan', 'triage', 'review', 'deliver', 'ship'] as const;
const ATTENTION: Attention<'retry' | 'finish' | 'replan' | 'ci'> = {
  what: 'Choose the behavior before another attempt.',
  why: 'Existing consumers depend on the default.',
  recommendation: {
    choice: 'retry',
    why: 'Preserve the default.',
    evidence: 'The existing caller reads it.',
    confidence: 'high',
    would_change: 'A decided new contract.',
  },
  choices: [
    {
      id: 'retry',
      label: 'Keep the default',
      does: 'Retry with the original default.',
      effect: 'retry',
      ruling: 'Keep the original default.',
    },
    {
      id: 'finish',
      label: 'Leave it',
      does: 'Accept this report and stop without doing more work.',
      effect: 'finish',
      ruling: '',
    },
  ],
  if_unanswered: 'The run waits indefinitely, with no additional spend.',
  links: ['archon-artifact://run/plan.md'],
};
const ASK: Decision = { done: false, attention: ATTENTION, pr: null };
const DELIVERY = {
  ready: false,
  reason: 'round_cap',
  pr_url: '',
  ci_rerun: 'none',
  summary: 'Four rounds left findings open.',
};

function parse(stage: Stage, block = false): WorkflowDefinition {
  const filename = `archon-${stage}${block ? '-block' : ''}.yaml`;
  const result = parseWorkflow(
    readFileSync(join(PACK, block ? stage : `${stage}-entry`, filename), 'utf8'),
    filename,
    providerRegistry
  );
  if (!result.workflow) throw new Error(result.error.error);
  return qualifyWorkflowResources(result.workflow, {
    source: 'project',
    pack: 'sdlc',
    workflow: block ? stage : `${stage}-entry`,
  });
}
function formatOf(stage: Stage) {
  const workflow = parse(stage, true);
  const result = workflow.nodes.find(n => n.id === workflow.returns);
  if (!result || !('output_format' in result)) throw new Error('missing public schema');
  return result.output_format;
}

describe('entry contracts and composed ownership', () => {
  test.each([...STAGES])('%s preserves its block schema and attention vocabularies', stage => {
    const entry = parse(stage);
    const result = entry.nodes.find(n => n.id === entry.returns);
    expect(result && 'output_format' in result && result.output_format).toEqual(formatOf(stage));
    expect(entry.outcome_field).toBe(parse(stage, true).outcome_field);
    const group = entry.nodes[0];
    if (group.kind !== 'loop_group') throw new Error('missing cycle');
    const decide = group.loop_group.nodes.find(n => n.id === 'decide');
    if (decide?.kind !== 'agent') throw new Error('missing decision');
    const text = { type: 'string' };
    const nonempty = { ...text, pattern: '\\S' };
    const recommendation = {
      choice: nonempty,
      why: nonempty,
      evidence: nonempty,
      confidence: { type: 'string', enum: [...CONFIDENCES] },
      would_change: nonempty,
    } satisfies Record<keyof Recommendation, unknown>;
    const choice = {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
      label: nonempty,
      does: nonempty,
      effect: { type: 'string', enum: [...STAGE_EFFECTS[stage]] },
      ruling: text,
    } satisfies Record<keyof Choice<string>, unknown>;
    const object = (properties: Record<string, unknown>) => ({
      type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
    });
    const attention = object({
      what: nonempty,
      why: nonempty,
      recommendation: object(recommendation),
      choices: { type: 'array', minItems: 1, items: object(choice) },
      if_unanswered: nonempty,
      links: { type: 'array', items: nonempty, minItems: 1 },
    } satisfies Record<keyof Attention<string>, unknown>);
    const schema = decide.output_format;
    if (!schema) throw new Error('missing decision schema');
    expect(record(schema.properties)?.attention).toEqual({ anyOf: [{ type: 'null' }, attention] });
  });
  test('CI uses the delivery contract and one authored command', () => {
    const review = parse('review').nodes[0];
    const deliver = parse('deliver', true).nodes.find(n => n.id === 'rounds');
    if (review.kind !== 'loop_group' || deliver?.kind !== 'loop_group')
      throw new Error('missing group');
    const ci = (nodes: typeof review.loop_group.nodes) => {
      const n = nodes.find(n => n.id === 'ci');
      return n && 'output_format' in n ? n.output_format : undefined;
    };
    expect(ci(review.loop_group.nodes)).toEqual(ci(deliver.loop_group.nodes));
    expect(readFileSync(join(PACK, 'review-entry/commands/ci.md'), 'utf8')).toBe(
      readFileSync(join(PACK, 'deliver/commands/ci.md'), 'utf8')
    );
  });
  test('the loaded queues own their sole wait and no included block waits', async () => {
    const discovered = await discoverWorkflows(REPO, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(
      discovered.errors.filter(e =>
        new Set([
          ...STAGES.flatMap(s => [`archon-${s}.yaml`, `archon-${s}-block.yaml`]),
          'archon-build-queue.yaml',
          'archon-merge-queue.yaml',
          'archon-intake.yaml',
          'archon-upkeep.yaml',
        ]).has(e.filename)
      )
    ).toEqual([]);
    for (const name of [
      'archon-build-queue',
      'archon-merge-queue',
      'archon-review-eval',
      'archon-intake',
      'archon-upkeep',
      ...STAGES.map(s => `archon-${s}-block`),
    ]) {
      const workflow = discovered.workflows.find(w => w.workflow.name === name)?.workflow;
      if (!workflow) throw new Error(`missing ${name}`);
      const waits: string[] = [];
      const visit = (nodes: readonly WorkflowDefinition['nodes'][number][]) => {
        for (const n of nodes) {
          if (n.kind === 'wait') waits.push(n.id);
          if (n.kind === 'loop_group') visit(n.loop_group.nodes);
        }
      };
      visit(workflow.nodes);
      expect(waits).toEqual(
        name.endsWith('-queue') || name === 'archon-intake' || name === 'archon-upkeep'
          ? ['ask']
          : []
      );
    }
  });
});

// Only stage work and agent judgments are canned. Entry scripts, graph bindings,
// durable wait writes, answers and resume snapshots all run through the real engine.
async function harness(
  stage: Stage,
  result: Record<string, unknown>,
  decision: Decision = ASK,
  ciState?: 'green' | 'pr_caused' | 'other',
  ciAllowed = true
) {
  const root = track(mkdtempSync(join(testHome, 'run-')));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  const counter = join(root, 'attempts');
  const decisionFile = join(root, 'decision.json');
  const resultFile = join(root, 'result.json');
  writeFileSync(decisionFile, JSON.stringify(decision));
  writeFileSync(resultFile, JSON.stringify(result));
  const entry = parse(stage);
  const group = entry.nodes[0];
  if (group.kind !== 'loop_group') throw new Error('missing cycle');
  group.loop_group.nodes = group.loop_group.nodes.map(n =>
    n.id === 'decide' && n.kind === 'agent'
      ? {
          id: n.id,
          kind: 'exec',
          runtime: 'bun',
          script: `await Bun.write(${JSON.stringify(join(root, 'decision-bindings.json'))}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('INPUTS_'))))); console.log(await Bun.file(${JSON.stringify(decisionFile)}).text())`,
          depends_on: n.depends_on,
          trigger_rule: n.trigger_rule,
          when: n.when,
          with: n.source.kind === 'command' ? n.source.with : undefined,
          output_format: n.output_format,
        }
      : n
  );
  if (ciState !== undefined) {
    group.loop_group.nodes = group.loop_group.nodes.map(n => {
      if (n.id !== 'ci' && n.id !== 'ci-target') return n;
      if (!('output_format' in n)) throw new Error('missing CI schema');
      const value =
        n.id === 'ci'
          ? { state: ciState, rerun: 'none', summary: 'The current-head CI conclusion.' }
          : { allowed: ciAllowed, summary: ciAllowed ? 'Current reviewed head.' : 'The reviewed head moved.', source: 'gh', pr: PR };
      return {
        id: n.id,
        kind: 'exec',
        runtime: 'bun',
        script: `console.log(${JSON.stringify(JSON.stringify(value))})`,
        when: n.when,
        depends_on: n.depends_on,
        output_format: n.output_format,
      };
    });
  }
  const block = parse(stage, true);
  block.nodes = [
    {
      id: 'work',
      kind: 'exec',
      runtime: 'bun',
      script: `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, 'attempt\\n'); await Bun.write(${JSON.stringify(join(root, 'bindings.json'))}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('INPUTS_'))))); console.log(await Bun.file(${JSON.stringify(resultFile)}).text());`,
      with: Object.fromEntries(Object.keys(block.inputs ?? {}).map(key => [key, `$INPUTS.${key}`])),
      output_format: formatOf(stage),
    },
  ];
  block.returns = 'work';
  // Replan remains a real include; its paid planner is replaced at the judgment boundary.
  const planner = parse('plan', true);
  planner.nodes = [
    {
      id: 'plan',
      kind: 'exec',
      runtime: 'bun',
      script: `console.log(await Bun.file(${JSON.stringify(join(root, 'plan.json'))}).text())`,
      output_format: formatOf('plan'),
    },
  ];
  planner.returns = 'plan';
  const workflow = makeTestComposedWorkflow(
    stage === 'deliver' ? [entry, block, planner] : [entry, block],
    entry.name
  );
  const storeRoot = join(root, 'store');
  let store = await createFileWorkflowStore({ root: storeRoot });
  let run = await store.createWorkflowRun({
    workflow_name: entry.name,
    user_message: 'Original trigger',
    metadata: {
      inputs: {
        ...Object.fromEntries(
          Object.entries(entry.inputs ?? {}).map(([key, value]) => [key, value.default ?? ''])
        ),
        work: 'Original work',
        target: 'Original target',
        ready_handoff: 'false',
        errors: 'false',
        part: '{"delivers":1,"parts":[{"part":1,"items":["A"]}]}',
        pull_request: '42',
        report: 'prior-investigation.md',
        scope: 'qualified-review-scope',
      },
    },
  });
  const artifacts = join(root, 'artifacts/runs', run.id);
  mkdirSync(artifacts, { recursive: true });
  await store.updateWorkflowRun(run.id, { output_root: root });
  await store.claimPendingWorkflowRun(run.id, cwd);
  const execute = async (resume = false) => {
    store = await createFileWorkflowStore({ root: storeRoot });
    const loaded = await store.getWorkflowRun(run.id);
    if (!loaded) throw new Error('run disappeared');
    run = loaded;
    const snapshot = await foldDagResumeSnapshot(await store.listWorkflowEvents(run.id), run.id);
    await executeDagWorkflow({
      deps: {
        store,
        providers: providerRegistry,
        getAgentProvider: () => {
          throw new Error('unexpected provider spend');
        },
        loadConfig: async () => ({
          assistant: undefined,
          commands: {},
          assistants: { claude: {}, codex: {} },
        }),
      },
      platform: {
        sendMessage: async () => {},
        getStreamingMode: () => 'batch',
        getPlatformType: () => 'test',
      },
      conversationId: 'test',
      cwd,
      workflow,
      workflowRun: run,
      workflowProvider: 'claude',
      workflowModel: undefined,
      artifactsDir: artifacts,
      stateDir: join(root, 'state'),
      logDir: join(root, 'logs'),
      baseBranch: 'dev',
      docsDir: 'docs',
      config: { assistant: undefined, commands: {}, assistants: { claude: {}, codex: {} } },
      workflowSourceRoots: liveSourceRoots(REPO),
      ...(resume ? { priorCompletedNodes: snapshot.completedNodeOutputs } : {}),
    });
    const updated = await store.getWorkflowRun(run.id);
    if (!updated) throw new Error('missing run');
    run = updated;
    return run;
  };
  const answer = async (
    choice: string,
    words = 'Complete answer, including prose and punctuation.'
  ) => {
    const wait = pausedAttentionWait(run);
    if (!wait?.pauseId) throw new Error(`no wait: ${JSON.stringify(run)}`);
    expect(
      await store.answerAttentionWait(run.id, {
        pauseId: wait.pauseId,
        answer: { decision: choice, text: words },
        answeredVia: 'cli',
        answeredAt: new Date().toISOString(),
      })
    ).toEqual({ answered: true });
    await store.resumeWorkflowRun(run.id);
    return execute(true);
  };
  return {
    root,
    artifacts,
    execute,
    answer,
    attempts: () => readFileSync(counter, 'utf8').trim().split('\n').length,
    events: () => store.listWorkflowEvents(run.id),
    resultFile,
    decisionFile,
    run: () => run,
  };
}

describe('durable answer-driven entries', () => {
  test('round_cap pauses once, retries one capped batch beyond max_iterations, and finish preserves the negative result without work', async () => {
    const h = await harness('deliver', DELIVERY);
    expect((await h.execute()).status).toBe('paused');
    const wait = pausedAttentionWait(h.run());
    expect(wait).toMatchObject({
      nodeId: 'cycle',
      bodyWaitId: 'ask',
      iteration: 1,
      form: 'select',
      labels: { sdlc: 'deliver', decision: 'round_cap' },
      options: ATTENTION.choices.map(({ id, label }) => ({ id, label })),
    });
    for (const field of [
      ATTENTION.what,
      ATTENTION.why,
      ATTENTION.recommendation.why,
      ATTENTION.recommendation.evidence,
      ATTENTION.recommendation.would_change,
      ATTENTION.if_unanswered,
      ...ATTENTION.links,
      ...ATTENTION.choices.map(c => c.does),
    ])
      expect(wait?.message).toContain(field);
    for (const iteration of [2, 3]) {
      expect((await h.answer('retry')).status).toBe('paused');
      expect(pausedAttentionWait(h.run())).toMatchObject({ iteration });
      expect(h.attempts()).toBe(iteration);
    }
    expect((await h.answer('finish')).status).toBe('completed');
    expect(h.attempts()).toBe(3);
    const events = await h.events();
    const result = events
      .reverse()
      .find(e => e.event_type === 'node_completed' && e.step_name === 'result');
    expect(result?.data.structured_output).toEqual({
      ...DELIVERY,
      summary: expect.stringContaining('Explicit disposition'),
    });
    const bindings = JSON.parse(readFileSync(join(h.root, 'bindings.json'), 'utf8'));
    expect(bindings).toMatchObject({
      INPUTS_ERRORS: 'false',
      INPUTS_PULL_REQUEST: '42',
      INPUTS_PART: '{"delivers":1,"parts":[{"part":1,"items":["A"]}]}',
    });
    expect(readFileSync(join(h.artifacts, 'attention-decisions.md'), 'utf8')).toContain(
      'Complete answer, including prose and punctuation.'
    );
  });
  test('a failed later attempt fails the run and emits reason:failed instead of reusing a previous result', async () => {
    const h = await harness('deliver', DELIVERY);
    expect((await h.execute()).status).toBe('paused');
    writeFileSync(h.resultFile, 'not JSON');
    expect((await h.answer('retry')).status).toBe('failed');
    expect(
      (await h.events())
        .reverse()
        .find(e => e.step_name === 'report' && e.event_type === 'node_completed')?.data
    ).toMatchObject({ structured_output: { ready: false, reason: 'failed' } });
  });
});

describe('attention boundary refusals', () => {
  test.each([
    { ...ATTENTION, choices: [] },
    { ...ATTENTION, choices: [ATTENTION.choices[0], ATTENTION.choices[0]] },
    { ...ATTENTION, recommendation: { ...ATTENTION.recommendation, choice: 'undeclared' } },
  ])('rejects an unanswerable decision', attention => {
    const ran = runPackScript('deliver-entry/scripts/settle', {
      inputs: {
        INPUTS_PREVIOUS: '',
        INPUTS_EFFECT: 'retry',
        INPUTS_RESULT: JSON.stringify(DELIVERY),
        INPUTS_DECISION: JSON.stringify({ ...ASK, attention }),
        INPUTS_PLAN: 'null',
        INPUTS_REPLAN: 'false',
      },
    });
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe('');
  });
  test.each([...STAGES])('%s refuses unsupported actions', stage => {
    for (const effect of ['replan', 'ci'] as const) {
      if ((STAGE_EFFECTS[stage] as readonly string[]).includes(effect)) continue;
      const attention = { ...ATTENTION, choices: [{ ...ATTENTION.choices[0], effect }] };
      const ran = runPackScript(`${stage}-entry/scripts/settle`, {
        inputs: {
          INPUTS_PREVIOUS: '',
          INPUTS_EFFECT: 'retry',
          INPUTS_RESULT: JSON.stringify({ ready: true }),
          INPUTS_DECISION: JSON.stringify({ ...ASK, attention, pr: PR }),
        },
      });
      expect(ran.code).toBe(1);
      expect(ran.stdout).toBe('');
    }
  });
  test.each([
    { ready: false, pr: PR },
    { ready: true, pr: null },
  ])('refuses CI without a Ready qualified PR', ({ ready, pr }) => {
    const attention = { ...ATTENTION, choices: [{ ...ATTENTION.choices[0], effect: 'ci' }] };
    const ran = runPackScript('review-entry/scripts/settle', {
      inputs: {
        INPUTS_PREVIOUS: '',
        INPUTS_EFFECT: 'retry',
        INPUTS_RESULT: JSON.stringify({ ready }),
        INPUTS_DECISION: JSON.stringify({ ...ASK, attention, pr }),
      },
    });
    expect(ran.code).toBe(1);
  });
});

const PLAN = {
  ready: false,
  open_questions: ['Keep the old default or adopt the new one?'],
  summary: 'Needs a decided default.',
  report: { type: 'archon_artifact', run_id: 'placeholder', path: 'plan.md' },
};
const REVIEW = {
  ready: true,
  action: 'none',
  findings_summary: 'Ready at the reviewed head.',
  report: { type: 'archon_artifact', run_id: 'placeholder', path: 'review/report.md' },
  discoveries: [],
  contract_left: [],
};

function pointAtRun(
  h: Awaited<ReturnType<typeof harness>>,
  result: Record<string, unknown>,
  path: string
) {
  mkdirSync(join(h.artifacts, 'review'), { recursive: true });
  writeFileSync(join(h.artifacts, path), 'The evidence report.');
  writeFileSync(
    h.resultFile,
    JSON.stringify({ ...result, report: { type: 'archon_artifact', run_id: h.run().id, path } })
  );
}

describe('advisory answers and stage actions', () => {
  test.each(['keep', 'change'])(
    'planning answer %s carries its complete ruling to another planning attempt',
    async choice => {
      const attention = {
        ...ATTENTION,
        recommendation: { ...ATTENTION.recommendation, choice: 'keep' },
        choices: [
          { ...ATTENTION.choices[0], id: 'keep', ruling: 'Keep the default.' },
          { ...ATTENTION.choices[0], id: 'change', ruling: 'Adopt the new default.' },
          ATTENTION.choices[1],
        ],
      };
      const h = await harness('plan', PLAN, { ...ASK, attention });
      pointAtRun(h, PLAN, 'plan.md');
      expect((await h.execute()).status).toBe('paused');
      expect(
        (await h.answer(choice, 'Full answer: use the agreed behavior.\nDetails survive.')).status
      ).toBe('paused');
      expect(h.attempts()).toBe(2);
      expect(readFileSync(join(h.artifacts, 'attention-decisions.md'), 'utf8')).toContain(
        choice === 'keep' ? 'Keep the default.' : 'Adopt the new default.'
      );
      expect(readFileSync(join(h.artifacts, 'attention-decisions.md'), 'utf8')).toContain(
        'Full answer: use the agreed behavior.\nDetails survive.'
      );
      expect(JSON.parse(readFileSync(join(h.root, 'bindings.json'), 'utf8'))).toMatchObject({
        INPUTS_WORK: expect.stringContaining('attention-decisions.md'),
        INPUTS_REPORT: 'prior-investigation.md',
      });
      expect((await h.answer('finish')).status).toBe('completed');
      expect(h.attempts()).toBe(2);
    }
  );
  test('a ready plan preserves its pointer and non-blocking questions on acknowledgement', async () => {
    const h = await harness('plan', { ...PLAN, ready: true });
    pointAtRun(h, { ...PLAN, ready: true }, 'plan.md');
    expect((await h.execute()).status).toBe('paused');
    expect((await h.answer('finish')).status).toBe('completed');
    expect(
      (await h.events())
        .reverse()
        .find(e => e.step_name === 'result' && e.event_type === 'node_completed')?.data
    ).toMatchObject({
      structured_output: {
        ready: true,
        open_questions: PLAN.open_questions,
        report: { run_id: h.run().id, path: 'plan.md' },
      },
    });
    expect(h.attempts()).toBe(1);
  });
  test('leave-draft finishes a Ready review without a CI call or another review', async () => {
    const h = await harness('review', REVIEW, {
      ...ASK,
      pr: PR,
      attention: {
        ...ATTENTION,
        choices: [{ ...ATTENTION.choices[0], effect: 'ci' }, ATTENTION.choices[1]],
      },
    });
    pointAtRun(h, REVIEW, 'review/report.md');
    expect((await h.execute()).status).toBe('paused');
    expect((await h.answer('finish')).status).toBe('completed');
    expect(h.attempts()).toBe(1);
    expect(
      (await h.events()).filter(
        e => e.step_name === 'cycle.ci' && e.event_type === 'node_completed'
      )
    ).toHaveLength(0);
  });
  test('replan asks about a blocked plan before any more delivery work', async () => {
    const h = await harness(
      'deliver',
      { ...DELIVERY, reason: 'replan' },
      {
        ...ASK,
        attention: {
          ...ATTENTION,
          choices: [{ ...ATTENTION.choices[0], effect: 'replan' }, ATTENTION.choices[1]],
        },
      }
    );
    expect((await h.execute()).status).toBe('paused');
    writeFileSync(join(h.artifacts, 'plan.md'), 'The blocked plan.');
    const plan = { ...PLAN, report: { ...PLAN.report, run_id: h.run().id } };
    writeFileSync(join(h.root, 'plan.json'), JSON.stringify(plan));
    expect((await h.answer('retry')).status).toBe('paused');
    expect(h.attempts()).toBe(1);
    // After the first replan, a concrete answer retries the planner, not delivery.
    writeFileSync(h.decisionFile, JSON.stringify(ASK));
    expect((await h.answer('retry')).status).toBe('paused');
    expect(h.attempts()).toBe(1);
    writeFileSync(
      join(h.root, 'plan.json'),
      JSON.stringify({ ...plan, ready: true, open_questions: [] })
    );
    expect((await h.answer('retry')).status).toBe('paused');
    expect(h.attempts()).toBe(2);
  });
});

describe('review CI continuation', () => {
  test.each(['green', 'pr_caused', 'other'] as const)(
    'the ci answer preserves the reviewed result when CI is %s',
    async state => {
      const h = await harness(
        'review',
        REVIEW,
        {
          ...ASK,
          pr: PR,
          attention: {
            ...ATTENTION,
            choices: [{ ...ATTENTION.choices[0], effect: 'ci' }, ATTENTION.choices[1]],
          },
        },
        state
      );
      pointAtRun(h, REVIEW, 'review/report.md');
      expect((await h.execute()).status).toBe('paused');
      if (state === 'green')
        writeFileSync(h.decisionFile, JSON.stringify({ done: true, attention: null, pr: PR }));
      expect((await h.answer('retry')).status).toBe(state === 'green' ? 'completed' : 'paused');
      expect(h.attempts()).toBe(1);
      expect(
        (await h.events()).filter(
          e => e.step_name === 'cycle.ci' && e.event_type === 'node_completed'
        )
      ).toHaveLength(1);
      if (state !== 'green') expect((await h.answer('finish')).status).toBe('completed');
    }
  );
  test('a refused CI target asks again without invoking CI or replacing the reviewed result', async () => {
    const h = await harness('review', REVIEW, {
      ...ASK,
      pr: PR,
      attention: {
        ...ATTENTION,
        choices: [{ ...ATTENTION.choices[0], effect: 'ci' }, ATTENTION.choices[1]],
      },
    }, 'green', false);
    pointAtRun(h, REVIEW, 'review/report.md');
    expect((await h.execute()).status).toBe('paused');
    expect((await h.answer('retry')).status).toBe('paused');
    expect(pausedAttentionWait(h.run())).toMatchObject({ iteration: 2 });
    expect(h.attempts()).toBe(1);
    const decisionBindings = JSON.parse(readFileSync(join(h.root, 'decision-bindings.json'), 'utf8'));
    expect(JSON.parse(decisionBindings.INPUTS_CI_TARGET)).toMatchObject({ allowed: false, summary: 'The reviewed head moved.' });
    expect(JSON.parse(decisionBindings.INPUTS_PREVIOUS)).toMatchObject({ result: { ready: true, findings_summary: REVIEW.findings_summary } });
    const events = await h.events();
    expect(events.filter(e => e.step_name === 'cycle.ci' && e.event_type === 'node_completed')).toHaveLength(0);
    expect(events.filter(e => e.step_name === 'cycle.ci-target' && e.event_type === 'node_completed').at(-1)?.data).toMatchObject({ structured_output: { allowed: false } });
    expect((await h.answer('finish')).status).toBe('completed');
    expect((await h.events()).reverse().find(e => e.step_name === 'result' && e.event_type === 'node_completed')?.data).toMatchObject({
      structured_output: { ...REVIEW, report: { ...REVIEW.report, run_id: h.run().id }, findings_summary: expect.stringContaining(REVIEW.findings_summary) },
    });
  });
  test.each(['current', 'moved', 'closed', 'merged'] as const)(
    'the CI boundary checks the qualified reviewed PR when %s',
    state => {
      const cwd = gitCheckout({}, track);
      const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString().trim();
      const run = runPackScript('review-entry/scripts/ci-target', {
        cwd,
        inputs: { INPUTS_PR: JSON.stringify(PR) },
        artifacts: { 'review/reviewed-head': head },
        gh: {
          pr: {
            headRefOid: state === 'moved' ? 'different' : head,
            state: state === 'closed' ? 'CLOSED' : state === 'merged' ? 'MERGED' : 'OPEN',
          },
        },
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        allowed: state === 'current' || state === 'merged',
        pr: { repo: PR.repo, number: PR.number },
      });
      expect(run.gh.every(argv => argv.includes(`--repo ${PR.repo.host}/${PR.repo.path}`))).toBe(
        true
      );
      expect(run.gh.some(argv => argv.startsWith('pr ready'))).toBe(false);
    }
  );
});

describe('triage and unowned Ready outcomes', () => {
  const TRIAGE = {
    contract: 'BLOCKED',
    route: 'no_action',
    pull_request: null,
    ready: false,
    type: { value: 'feature', reason: 'New behavior.' },
    size: { value: 's', reason: 'One outcome.' },
    complexity: { value: 'low', reason: 'Small.' },
    importance: { value: 'medium', reason: 'Needed.' },
    urgency: { value: 'none', reason: 'No deadline.' },
    labels: ['archon-blocked'],
    published: false,
    proposed_edits: { title: '', body: '' },
    blocked_reason: 'Needs a maintainer decision.',
    blocked_by: [],
    closure: null,
    summary: 'Blocked on a decided default.',
    report: PLAN.report,
  };
  test.each(['BLOCKED', 'NEEDS_CONTRACT_WORK', 'READY', 'NO_ACTION'])(
    '%s preserves the triage outcome through its disposition',
    async contract => {
      const terminal = contract === 'NO_ACTION';
      const result = {
        ...TRIAGE,
        contract,
        ready: contract === 'READY',
        report: { ...PLAN.report, path: 'triage.md' },
      };
      const h = await harness(
        'triage',
        result,
        terminal ? { done: true, attention: null, pr: null } : ASK
      );
      pointAtRun(h, result, 'triage.md');
      expect((await h.execute()).status).toBe(terminal ? 'completed' : 'paused');
      if (!terminal) expect((await h.answer('finish')).status).toBe('completed');
      expect(h.attempts()).toBe(1);
      expect(
        (await h.events())
          .reverse()
          .find(e => e.step_name === 'result' && e.event_type === 'node_completed')?.data
          .structured_output
      ).toMatchObject({ contract, ready: contract === 'READY', report: { path: 'triage.md' } });
    }
  );
  test.each(['deliver', 'ship'] as const)(
    'unowned Ready %s asks and finish does no more work',
    async stage => {
      const result =
        stage === 'deliver'
          ? { ...DELIVERY, ready: true, reason: 'delivered' }
          : {
              delivered: true,
              reason: 'delivered',
              pr_url: 'https://github.com/example/repo/pull/42',
              summary: 'Ready, awaiting a disposition.',
            };
      const h = await harness(stage, result);
      expect((await h.execute()).status).toBe('paused');
      expect((await h.answer('finish')).status).toBe('completed');
      expect(h.attempts()).toBe(1);
    }
  );
  test('ship reports a failed core attempt without asking', async () => {
    const h = await harness('ship', {
      delivered: true,
      reason: 'delivered',
      pr_url: '',
      summary: 'Earlier ready.',
    });
    writeFileSync(h.resultFile, 'not JSON');
    expect((await h.execute()).status).toBe('failed');
    expect(
      (await h.events())
        .reverse()
        .find(e => e.step_name === 'report' && e.event_type === 'node_completed')?.data
        .structured_output
    ).toMatchObject({ delivered: false, reason: 'failed' });
  });
});

test.each([
  ['deliver', 'retry'],
  ['deliver', 'replan'],
  ['ship', 'retry'],
] as const)('%s refuses a failed core report before attention on %s', (stage, effect) => {
  const result =
    stage === 'deliver'
      ? { ...DELIVERY, reason: 'failed' }
      : { delivered: false, reason: 'failed', pr_url: '', summary: 'The core node failed.' };
  const run = runPackScript(`${stage}-entry/scripts/settle`, {
    inputs: {
      INPUTS_PREVIOUS: 'null',
      INPUTS_EFFECT: effect,
      INPUTS_RESULT: JSON.stringify(result),
      INPUTS_DECISION: JSON.stringify(ASK),
      ...(stage === 'deliver' ? { INPUTS_PLAN: 'null', INPUTS_REPLAN: 'false' } : {}),
    },
  });
  expect(run.code).toBe(1);
  expect(run.stdout).toBe('');
});
