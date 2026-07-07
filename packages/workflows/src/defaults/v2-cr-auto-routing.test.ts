/**
 * RED-PHASE ACCEPTANCE SCAFFOLD — Story A2.1 "Wire DS TA CR Sequence".
 *
 * Behavioral DAG routing assertions driven through the REAL dag-executor against
 * the v2 workflow YAML, with in-memory mocked providers keyed by nodeId. Written
 * BEFORE the A2.1 delta is implemented. Every case keys its mock responses on the
 * post-rename node id `code-review-auto`, so on the current YAML (node still
 * `code-review`) the mock never matches and the assertions fail — that is the
 * intended red state.
 *
 * This file uses mock.module('@archon/paths'), which is process-global and
 * irreversible in Bun. It MUST run in its own `bun test` invocation — never in a
 * process that also loads v2-story-dag.test.ts (which mocks the same module).
 * Register it as a standalone batch in packages/workflows/package.json.
 *
 * Covers (executable red):
 *   AC1.7   happy path — valid contract gate PASS drives the positive route.
 *   AC2.1   CR hard-failure (schema-invalid) → guard SKIPPED → no dev-story re-entry.
 *   AC2.2   CR gate="ERROR" value → guard exits non-zero → no dev-story re-entry.
 *   AC2.3   dev-story hard-failure → TA + CR SKIPPED → run failed.
 *   AC2.4   tea-automate hard-failure → CR SKIPPED → run failed.
 *   AC3.1   story_ref mismatch → ERROR (guard fails), no dev-story re-entry.
 *   AC3.2   shared story_ref observed by dev-story, tea-automate, code-review-auto.
 *   Q1      gate="CONCERNS" routes as PASS (positive → tea-rv, no dev-story loop).
 */

import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// ── @archon/paths mock (see file header for the isolation constraint) ───────
import * as realPaths from '@archon/paths';

const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
  captureWorkflowCompleted: mock(() => {}),
}));

import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

import { executeDagWorkflow } from '../dag-executor';
import { parseWorkflow } from '../loader';
import type { WorkflowRun } from '../schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from '../deps';
import type { IWorkflowStore } from '../store';
import type { SendQueryOptions } from '@archon/providers/types';

const V2_FILE = join(
  import.meta.dir,
  '../../../../.archon/workflows/defaults/bmad-dev-story-with-tea-fix-loop-v2.yml'
);

// The canonical story key seeded into the fixture sprint-status.
const CANONICAL_KEY = 'a1-2-preserve-story-input-resolution';

const MOCK_RUN = {
  id: 'dag-v2-cr-auto-run',
  workflow_name: 'bmad-dev-story-with-tea-fix-loop-v2',
  conversation_id: 'conv-v2-cr-auto',
  parent_conversation_id: null,
  codebase_id: null,
  status: 'running' as const,
  user_message: 'test',
  metadata: {},
  started_at: new Date(),
  completed_at: null,
  last_activity_at: null,
  working_path: null,
};

type NodeEventState = 'completed' | 'failed' | 'skipped';

function createTrackedStore(
  nodeState: Record<string, NodeEventState>,
  runFailedRef: { value: boolean }
): IWorkflowStore {
  return {
    createWorkflowRun: mock(() => Promise.resolve({ ...MOCK_RUN })),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() => Promise.resolve({ ...MOCK_RUN })),
    updateWorkflowRun: mock(() => Promise.resolve()),
    persistRouteDecisionTransition: mock(input =>
      Promise.resolve({ ...MOCK_RUN, id: input.workflow_run_id, metadata: input.metadata })
    ),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => {
      runFailedRef.value = true;
      return Promise.resolve();
    }),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: (data: {
      workflow_run_id: string;
      event_type: string;
      step_name?: string;
      data?: Record<string, unknown>;
    }) => {
      const { event_type, step_name } = data;
      if (step_name) {
        if (event_type === 'node_completed') nodeState[step_name] = 'completed';
        else if (event_type === 'node_failed') nodeState[step_name] = 'failed';
        else if (event_type === 'node_skipped') nodeState[step_name] = 'skipped';
      }
      return Promise.resolve();
    },
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
    getWorkflowNodeSession: mock(() => Promise.resolve(null)),
    upsertWorkflowNodeSession: mock(() => Promise.resolve()),
    deleteWorkflowNodeSessions: mock(() => Promise.resolve({ deleted: 0 })),
  };
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

function makeWorkflowRun(cwd: string, userMessage: string): WorkflowRun {
  return { ...MOCK_RUN, user_message: userMessage, working_path: cwd, metadata: {} };
}

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  prRemote: 'origin',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

/**
 * A node response may be a plain structured object OR a control sentinel:
 *   { __throw: true }  → provider throws (simulates an execution/SDK error →
 *                        node state:'failed' = the hard ERROR channel).
 * Any other object is emitted as the node's structuredOutput.
 */
type NodeResponse = Record<string, unknown> | { __throw: true };

function createMockDeps(
  store: IWorkflowStore,
  nodeResponses: Record<string, NodeResponse>,
  providerCalls: string[],
  promptsByNode: Record<string, string>
): WorkflowDeps {
  const getAgentProvider = mock(() => {
    const sendQuery = mock(function* (
      prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options?: SendQueryOptions
    ) {
      const nodeId = (options?.nodeConfig as Record<string, unknown> | undefined)?.nodeId as
        | string
        | undefined;
      if (nodeId) {
        providerCalls.push(nodeId);
        promptsByNode[nodeId] = prompt;
      }
      const resp = (nodeId && nodeResponses[nodeId]) || {};
      if ((resp as { __throw?: boolean }).__throw) {
        // Simulate an execution/SDK error → dag-executor marks the node failed.
        throw new Error(`simulated provider failure for ${nodeId}`);
      }
      yield { type: 'assistant', content: JSON.stringify(resp) };
      yield {
        type: 'result',
        sessionId: `session-${nodeId ?? 'unknown'}`,
        structuredOutput: Object.keys(resp).length ? resp : undefined,
      };
    });
    return {
      sendQuery,
      getType: () => 'codex',
      getCapabilities: () => ({
        sessionResume: false,
        mcp: false,
        hooks: false,
        skills: false,
        agents: false,
        toolRestrictions: false,
        structuredOutput: 'enforced' as const,
        envInjection: false,
        costControl: false,
        effortControl: false,
        thinkingControl: false,
        fallbackModel: false,
        sandbox: false,
        nativeTools: false,
      }),
    };
  });

  return {
    store,
    getAgentProvider,
    loadConfig: mock(() => Promise.resolve(minimalConfig)),
  };
}

/** A full valid CR contract envelope for the post-A2.1 schema. */
function crContract(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    contract_version: '1.0',
    workflow: 'bmad-dev-story-with-tea-fix-loop-v2',
    node: 'code-review-auto',
    gate: 'PASS',
    round: 1,
    findings_count: 0,
    open_findings_file: 'findings/open-findings.md',
    decision_log_file: 'decision-log.md',
    code_review_report: 'No findings.',
    story_ref: CANONICAL_KEY,
    ...overrides,
  };
}

async function buildFixtureDir(baseDir: string): Promise<string> {
  const cwd = join(baseDir, 'v2-cr-auto-fixture');
  await mkdir(cwd, { recursive: true });

  const skills = [
    'bmad-dev-story',
    'bmad-code-review',
    // Post-M1.1 skill dir; stubbed so command discovery does not fail once the
    // node retargets bmad-code-review-auto. Harmless while the node is still
    // `bmad-code-review`.
    'bmad-code-review-auto',
    'bmad-testarch-automate',
    'bmad-testarch-test-review',
    'bmad-testarch-nfr',
    'bmad-testarch-trace',
  ];
  for (const skill of skills) {
    await mkdir(join(cwd, '.agents/skills', skill), { recursive: true });
    await writeFile(join(cwd, '.agents/skills', skill, 'SKILL.md'), `# ${skill}`);
  }

  await mkdir(join(cwd, '_bmad/bmm'), { recursive: true });
  await writeFile(join(cwd, '_bmad/bmm/config.yaml'), 'project_name: test');

  await mkdir(join(cwd, '_bmad-output/implementation-artifacts'), { recursive: true });
  await writeFile(
    join(cwd, '_bmad-output/implementation-artifacts/sprint-status.yaml'),
    [
      'project: test',
      'development_status:',
      `  ${CANONICAL_KEY}:`,
      '    status: ready-for-dev',
      '    last_updated: 2026-07-07',
    ].join('\n')
  );

  await mkdir(join(cwd, '.archon/commands'), { recursive: true });
  // Both the current (bmad-code-review) and post-rename (bmad-code-review-auto)
  // command stubs are seeded so the node resolves in either state.
  for (const cmd of ['bmad-code-review', 'bmad-code-review-auto', 'archon-create-pr']) {
    await writeFile(join(cwd, '.archon/commands', `${cmd}.md`), `# ${cmd}`);
  }
  return cwd;
}

interface DagRun {
  nodeState: Record<string, NodeEventState>;
  providerCalls: string[];
  promptsByNode: Record<string, string>;
  runFailed: boolean;
}

async function runV2Dag(opts: {
  cwd: string;
  arguments?: string;
  nodeResponses?: Record<string, NodeResponse>;
}): Promise<DagRun> {
  const yamlText = await readFile(V2_FILE, 'utf-8');
  const parseResult = parseWorkflow(yamlText, 'test');
  if (!parseResult.workflow)
    throw new Error(`Failed to parse v2 workflow: ${parseResult.error?.error}`);
  const workflow = parseResult.workflow;

  const nodeState: Record<string, NodeEventState> = {};
  const providerCalls: string[] = [];
  const promptsByNode: Record<string, string> = {};
  const runFailedRef = { value: false };

  const store = createTrackedStore(nodeState, runFailedRef);
  const deps = createMockDeps(store, opts.nodeResponses ?? {}, providerCalls, promptsByNode);
  const platform = createMockPlatform();
  const workflowRun = makeWorkflowRun(opts.cwd, opts.arguments ?? '');

  try {
    await executeDagWorkflow(
      deps,
      platform,
      'conv-v2-cr-auto',
      opts.cwd,
      {
        name: workflow.name,
        nodes: workflow.nodes as Parameters<typeof executeDagWorkflow>[4]['nodes'],
        model: workflow.model,
        provider: workflow.provider,
        persist_sessions: false,
      },
      workflowRun,
      workflow.provider ?? 'codex',
      workflow.model,
      join(opts.cwd, 'artifacts'),
      join(opts.cwd, 'logs'),
      'main',
      join(opts.cwd, 'docs'),
      minimalConfig
    );
  } catch {
    runFailedRef.value = true;
  }

  return { nodeState, providerCalls, promptsByNode, runFailed: runFailedRef.value };
}

let fixtureDir = '';
let cwdFixture = '';

beforeAll(async () => {
  fixtureDir = join(tmpdir(), `v2-cr-auto-test-${process.pid}`);
  cwdFixture = await buildFixtureDir(fixtureDir);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

// ── AC1.7 — happy path, JSON contract drives routing ────────────────────────
describe('AC1 — CR JSON contract drives the positive route', () => {
  it('AC1.7 [P0] valid contract gate=PASS + matching story_ref → verify PASS → positive route to tea-rv', async () => {
    // RED: mock is keyed on `code-review-auto`; the current node is `code-review`,
    // so CR emits no structured output → guard has no gate → route does not reach
    // tea-rv. GREEN once the node is renamed and the envelope is honored.
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: {
        'dev-story': {},
        'tea-automate': {},
        'code-review-auto': crContract({ gate: 'PASS' }),
        'tea-rv': {},
        'tea-nr': {},
        'tea-tr': {},
        'create-pull-request': {},
      },
    });

    expect(run.nodeState['code-review-auto']).toBe('completed');
    expect(run.nodeState['verify-story-identity']).toBe('completed');
    // The positive route actually activated tea-rv — proof the JSON gate (not the
    // markdown report) drove routing.
    expect(run.providerCalls).toContain('tea-rv');
    expect(run.nodeState['tea-rv']).toBe('completed');
    expect(run.runFailed).toBe(false);
  });
});

// ── AC2 — ERROR is separate from FAIL and never feeds the dev-story loop ─────
describe('AC2 — DS/TA/CR failures are ERROR, not a fix-loop back to dev-story', () => {
  it('AC2.1 [P0] CR hard-failure (execution/contract error) → verify SKIPPED → code-review-gate does NOT re-enter dev-story → run failed', async () => {
    // Simulate the hard ERROR channel: the CR provider throws (SDK error OR an
    // enforced-schema violation, which on codex maxReasks=0 throws → state:'failed').
    // trigger_rule all_success SKIPS verify-story-identity; the route_loop sees
    // from!=='completed' and returns failed WITHOUT evaluating negative→dev-story.
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: {
        'dev-story': {},
        'tea-automate': {},
        'code-review-auto': { __throw: true },
      },
    });

    expect(run.nodeState['code-review-auto']).toBe('failed');
    expect(run.nodeState['verify-story-identity']).toBe('skipped');
    // dev-story ran exactly once (initial); the negative route never re-entered it.
    expect(run.providerCalls.filter(c => c === 'dev-story').length).toBe(1);
    expect(run.nodeState['code-review-gate']).not.toBe('completed');
    expect(run.nodeState['tea-rv']).not.toBe('completed');
    expect(run.runFailed).toBe(true);
  });

  it('AC2.2 [P0] CR completes with a VALID contract gate="ERROR" → guard exits non-zero → dev-story NOT re-entered → run failed', async () => {
    // The soft/value ERROR channel and the core A2.1 bug fix. CR completed (node
    // state:'completed'), so the route_loop WOULD evaluate its condition; with the
    // gate value != PASS the naive negative route would send traffic back to
    // dev-story. Task 3.1 makes verify-story-identity treat an ERROR gate value as
    // an identity/tooling error → exit 1 → converts to the hard failed channel.
    // RED on BOTH counts: node id is still `code-review`, and the guard still
    // `printf`s the gate verbatim (ERROR would route negative today).
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: {
        'dev-story': {},
        'tea-automate': {},
        'code-review-auto': crContract({ gate: 'ERROR' }),
      },
    });

    expect(run.nodeState['code-review-auto']).toBe('completed');
    expect(
      run.nodeState['verify-story-identity'],
      'guard must FAIL (exit non-zero) on an ERROR gate value, not print it as routable output'
    ).toBe('failed');
    expect(
      run.providerCalls.filter(c => c === 'dev-story').length,
      'ERROR must not feed the dev-story fix loop'
    ).toBe(1);
    expect(run.nodeState['tea-rv']).not.toBe('completed');
    expect(run.runFailed).toBe(true);
  });

  it('AC2.3 [P1] dev-story hard-failure → tea-automate & code-review-auto SKIPPED → run failed (DS error is not quality work)', async () => {
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: { 'dev-story': { __throw: true } },
    });

    expect(run.nodeState['dev-story']).toBe('failed');
    expect(run.nodeState['tea-automate']).toBe('skipped');
    expect(run.nodeState['code-review-auto']).toBe('skipped');
    expect(run.providerCalls.filter(c => c === 'dev-story').length).toBe(1);
    expect(run.runFailed).toBe(true);
  });

  it('AC2.4 [P1] tea-automate hard-failure → code-review-auto SKIPPED → run failed', async () => {
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: { 'dev-story': {}, 'tea-automate': { __throw: true } },
    });

    expect(run.nodeState['tea-automate']).toBe('failed');
    expect(run.nodeState['code-review-auto']).toBe('skipped');
    expect(run.nodeState['tea-rv']).not.toBe('completed');
    expect(run.runFailed).toBe(true);
  });
});

// ── AC3 — shared story identity across DS, TA, CR ───────────────────────────
describe('AC3 — DS/TA/CR operate on the same resolved story_ref', () => {
  it('AC3.1 [P0] story_ref mismatch (CR contract ref ≠ resolved ref) → ERROR (guard fails), dev-story NOT re-entered, run failed', async () => {
    // Mismatch must produce ERROR, never FAIL/negative-route. Even with gate=FAIL
    // (the case that would normally send traffic to dev-story), the identity guard
    // intercepts first. Mirrors DAG-A4-1 but on the renamed node.
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: {
        'dev-story': {},
        'tea-automate': {},
        'code-review-auto': crContract({ gate: 'FAIL', story_ref: 'a2-1-some-other-story' }),
      },
    });

    expect(run.nodeState['verify-story-identity']).toBe('failed');
    expect(run.nodeState['code-review-gate']).toBe('skipped');
    expect(
      run.providerCalls.filter(c => c === 'dev-story').length,
      'identity mismatch must not re-enter dev-story via the negative route'
    ).toBe(1);
    expect(run.runFailed).toBe(true);
  });

  it('AC3.2 [P1] the same resolved story_ref value is observed by dev-story, tea-automate, and code-review-auto', async () => {
    // Shared identity: the canonical key threads through all three prompts (via
    // $ARGUMENTS and, for CR, the prompt_suffix). If $ARGUMENTS alone is
    // insufficient the dev must add an echoing prompt_suffix to dev-story/tea-automate
    // (Task 4.2) — either way this assertion must hold.
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: {
        'dev-story': {},
        'tea-automate': {},
        'code-review-auto': crContract({ gate: 'PASS' }),
        'tea-rv': {},
        'tea-nr': {},
        'tea-tr': {},
        'create-pull-request': {},
      },
    });

    for (const nodeId of ['dev-story', 'tea-automate', 'code-review-auto']) {
      expect(
        run.promptsByNode[nodeId],
        `${nodeId} must have been invoked so its prompt can be inspected`
      ).toBeDefined();
      expect(
        run.promptsByNode[nodeId],
        `${nodeId} prompt must carry the shared canonical story_ref`
      ).toContain(CANONICAL_KEY);
    }
  });

  it('AC3.3 [P0] non-canonical alias input → all three core nodes receive the resolved canonical key (R2-F1)', async () => {
    // The original failure mode was alias input drifting from canonical CR
    // verification. AC3.2 starts from the canonical key, which does not exercise
    // the resolver path that end users actually trigger. This test passes the
    // epic.story alias 'a1.2' and asserts the resolver's canonical output threads
    // through every downstream prompt.
    const aliasInput = 'a1.2';
    expect(aliasInput).not.toBe(CANONICAL_KEY);

    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: aliasInput,
      nodeResponses: {
        'dev-story': {},
        'tea-automate': {},
        'code-review-auto': crContract({ gate: 'PASS' }),
        'tea-rv': {},
        'tea-nr': {},
        'tea-tr': {},
        'create-pull-request': {},
      },
    });

    expect(run.runFailed).toBe(false);
    for (const nodeId of ['dev-story', 'tea-automate', 'code-review-auto']) {
      expect(run.promptsByNode[nodeId], `${nodeId} must have been invoked`).toBeDefined();
      expect(
        run.promptsByNode[nodeId],
        `${nodeId} prompt must carry the resolved canonical story_ref, not the raw alias`
      ).toContain(CANONICAL_KEY);
    }
  });
});

// ── Q1 — CONCERNS routing decision (pending maintainer confirmation) ────────
describe('Q1 — CONCERNS gate routing (A2.1 recommendation: non-blocking → route as PASS)', () => {
  it('Q1.1 [P1] gate="CONCERNS" routes as PASS (positive → tea-rv, dev-story NOT looped)', async () => {
    // DECISION-DEPENDENT: the A2.1 recommendation treats CONCERNS as non-blocking
    // (defer authoritative handling to A4 quality-gate-summary). If the maintainer
    // instead chooses to block on CONCERNS, invert this to assert the negative
    // route (guard prints CONCERNS != PASS → dev-story) and update the guard.
    // RED until the gate enum admits CONCERNS and the guard treats it as PASS.
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: CANONICAL_KEY,
      nodeResponses: {
        'dev-story': {},
        'tea-automate': {},
        'code-review-auto': crContract({ gate: 'CONCERNS', findings_count: 2 }),
        'tea-rv': {},
        'tea-nr': {},
        'tea-tr': {},
        'create-pull-request': {},
      },
    });

    expect(run.nodeState['verify-story-identity']).toBe('completed');
    expect(run.providerCalls).toContain('tea-rv');
    expect(
      run.providerCalls.filter(c => c === 'dev-story').length,
      'CONCERNS must not loop dev-story under the non-blocking policy'
    ).toBe(1);
    expect(run.runFailed).toBe(false);
  });
});
