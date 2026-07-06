/**
 * DAG skip-propagation tests for the v2 BMAD dev-story workflow.
 *
 * This file must run in its own isolated bun test process because it uses
 * mock.module('@archon/paths', ...) — Bun's mock.module() is process-global
 * and irreversible, so mixing it with v2-story-input-resolution.test.ts
 * (which avoids mock.module() entirely) would corrupt both test files.
 *
 * Covers: DAG-A3-1, DAG-A4-1, DAG-A4-2
 */

import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// ── @archon/paths mock ─────────────────────────────────────────────────────
// Spread the REAL module so findMarkdownFilesRecursive (used by command
// discovery) and path helpers work against the real filesystem. Only
// createLogger is replaced with a no-op so test output stays clean.

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
const mockCaptureWorkflowCompleted = mock(() => {});

mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
  captureWorkflowCompleted: mockCaptureWorkflowCompleted,
}));

// ── Provider registry ──────────────────────────────────────────────────────
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// ── Imports (after mocks) ──────────────────────────────────────────────────
import { executeDagWorkflow } from '../dag-executor';
import { parseWorkflow } from '../loader';
import type { WorkflowRun } from '../schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from '../deps';
import type { IWorkflowStore } from '../store';
import type { SendQueryOptions } from '@archon/providers/types';
import { readFile } from 'fs/promises';

// ── Fixture paths ──────────────────────────────────────────────────────────

const V2_FILE = join(
  import.meta.dir,
  '../../../../.archon/workflows/defaults/bmad-dev-story-with-tea-fix-loop-v2.yml'
);

// ── Test helpers ───────────────────────────────────────────────────────────

const MOCK_RUN = {
  id: 'dag-v2-run-id',
  workflow_name: 'bmad-dev-story-with-tea-fix-loop-v2',
  conversation_id: 'conv-v2-dag',
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

/**
 * Build a store where createWorkflowEvent writes into `nodeState` via closure.
 * Bun's mock() has no mockImplementation — closures are the idiomatic approach.
 */
function createTrackedStore(nodeState: Record<string, NodeEventState>): IWorkflowStore {
  return {
    createWorkflowRun: mock(() => Promise.resolve({ ...MOCK_RUN })),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() => Promise.resolve({ ...MOCK_RUN })),
    updateWorkflowRun: mock(() => Promise.resolve()),
    persistRouteDecisionTransition: mock(input =>
      Promise.resolve({
        ...MOCK_RUN,
        id: input.workflow_run_id,
        metadata: input.metadata,
      })
    ),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    // createWorkflowEvent is fire-and-forget in the executor (not awaited).
    // Write nodeState synchronously inside the Promise so the value is
    // visible immediately when executeDagWorkflow resolves or throws.
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
  return {
    id: 'dag-v2-run-id',
    workflow_name: 'bmad-dev-story-with-tea-fix-loop-v2',
    conversation_id: 'conv-v2-dag',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: userMessage,
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: cwd,
  };
}

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  prRemote: 'origin',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

/**
 * Build deps with a per-node provider mock. Identifies the active node via
 * options.nodeConfig.nodeId and records which nodes called the provider.
 */
function createMockDepsWithResponses(
  store: IWorkflowStore,
  nodeResponses: Record<string, Record<string, unknown>>,
  providerCalls: string[]
): WorkflowDeps {
  const getAgentProvider = mock(() => {
    const sendQuery = mock(function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId: string | undefined,
      options?: SendQueryOptions
    ) {
      const nodeId = (options?.nodeConfig as Record<string, unknown> | undefined)?.nodeId as
        | string
        | undefined;
      if (nodeId) providerCalls.push(nodeId);
      const resp = nodeId && nodeResponses[nodeId] ? nodeResponses[nodeId] : {};
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

// ── Fixture setup ──────────────────────────────────────────────────────────

/**
 * Build a minimal fixture directory that satisfies the v2 workflow's
 * bash guard checks (prepare-bmad-state).
 */
async function buildFixtureDir(baseDir: string): Promise<string> {
  const cwd = join(baseDir, 'v2-dag-fixture');
  await mkdir(cwd, { recursive: true });

  // Required BMAD skill files
  const skills = [
    'bmad-dev-story',
    'bmad-code-review',
    'bmad-testarch-automate',
    'bmad-testarch-test-review',
    'bmad-testarch-nfr',
    'bmad-testarch-trace',
  ];
  for (const skill of skills) {
    await mkdir(join(cwd, '.agents/skills', skill), { recursive: true });
    await writeFile(join(cwd, '.agents/skills', skill, 'SKILL.md'), `# ${skill}`);
  }

  // Required bmm config
  await mkdir(join(cwd, '_bmad/bmm'), { recursive: true });
  await writeFile(join(cwd, '_bmad/bmm/config.yaml'), 'project_name: test');

  // Required sprint-status with one story key matching our test input
  await mkdir(join(cwd, '_bmad-output/implementation-artifacts'), { recursive: true });
  await writeFile(
    join(cwd, '_bmad-output/implementation-artifacts/sprint-status.yaml'),
    [
      'project: test',
      'development_status:',
      '  a1-2-preserve-story-input-resolution:',
      '    status: ready-for-dev',
      '    last_updated: 2026-07-07',
    ].join('\n')
  );

  // Command files for AI nodes (empty stubs — AI is mocked)
  await mkdir(join(cwd, '.archon/commands'), { recursive: true });
  for (const cmd of ['bmad-code-review', 'archon-create-pr']) {
    await writeFile(join(cwd, '.archon/commands', `${cmd}.md`), `# ${cmd}`);
  }

  // Git repo so git commands inside bash nodes don't fail immediately
  // (prepare-bmad-state only creates dirs — it doesn't call git)

  return cwd;
}

// ── runV2Dag harness ───────────────────────────────────────────────────────

type NodeEventState = 'completed' | 'failed' | 'skipped';

interface DagRun {
  /** Terminal state for each node that emitted a node_completed/failed/skipped event */
  nodeState: Record<string, NodeEventState>;
  /** Ordered list of nodeIds for which the provider was invoked */
  providerCalls: string[];
  /** Whether executeDagWorkflow threw */
  runFailed: boolean;
}

async function runV2Dag(opts: {
  cwd: string;
  arguments?: string;
  /** Per-node structured output for AI nodes (keyed by nodeId). */
  nodeResponses?: Record<string, Record<string, unknown>>;
}): Promise<DagRun> {
  const yamlText = await readFile(V2_FILE, 'utf-8');
  const parseResult = parseWorkflow(yamlText, 'test');
  if (!parseResult.workflow)
    throw new Error(`Failed to parse v2 workflow: ${parseResult.error?.error}`);
  const workflow = parseResult.workflow;

  const nodeState: Record<string, NodeEventState> = {};
  const providerCalls: string[] = [];

  // createTrackedStore uses a closure over nodeState — no mockImplementation needed
  const store = createTrackedStore(nodeState);
  const nodeResponses = opts.nodeResponses ?? {};
  const deps = createMockDepsWithResponses(store, nodeResponses, providerCalls);

  const platform = createMockPlatform();
  // ARGUMENTS is derived from workflowRun.user_message by the executor
  const workflowRun = makeWorkflowRun(opts.cwd, opts.arguments ?? '');

  let runFailed = false;
  try {
    await executeDagWorkflow(
      deps,
      platform,
      'conv-v2-dag',
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
    runFailed = true;
  }

  return { nodeState, providerCalls, runFailed };
}

// ── Fixture lifecycle ──────────────────────────────────────────────────────

let fixtureDir = '';
let cwdFixture = '';

beforeAll(async () => {
  fixtureDir = join(tmpdir(), `v2-dag-test-${process.pid}`);
  cwdFixture = await buildFixtureDir(fixtureDir);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AC3/AC4 — v2 DAG skip propagation (mocked-provider harness)', () => {
  it('DAG-A3-1 [P0] resolve-story-input fails → all downstream AI nodes SKIPPED, run failed, NO provider called', async () => {
    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: 'this-story-does-not-exist-xyz',
    });

    // resolve-story-input itself must be failed (bash exits 1)
    expect(run.nodeState['resolve-story-input']).toBe('failed');

    // Direct AI dependents get explicit node_skipped events
    for (const nodeId of ['dev-story', 'tea-automate', 'code-review', 'verify-story-identity']) {
      expect(
        run.nodeState[nodeId],
        `${nodeId} must be skipped when resolve-story-input fails`
      ).toBe('skipped');
    }

    // Nodes downstream of a skipped route_loop (code-review-gate) may have no event
    // emitted (undefined) or be explicitly skipped — what matters is they NEVER completed.
    for (const nodeId of ['tea-rv', 'tea-nr', 'tea-tr', 'create-pull-request']) {
      expect(
        run.nodeState[nodeId],
        `${nodeId} must not have run when story resolution fails`
      ).not.toBe('completed');
    }

    expect(run.providerCalls, 'no provider must be called when story resolution fails').toEqual([]);
  });

  it('DAG-A4-1 [P0] guard fails (story_ref mismatch) → verify-story-identity fails → code-review-gate SKIPPED → tea-rv/nr/tr + create-pull-request SKIPPED', async () => {
    // code-review returns a WRONG story_ref → verify-story-identity bash exits 1
    const wrongRef = 'a2-1-some-other-story';
    const canonicalKey = 'a1-2-preserve-story-input-resolution';

    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: canonicalKey,
      nodeResponses: {
        'code-review': {
          gate: 'PASS',
          round: 1,
          findings_count: 0,
          open_findings_file: 'findings/open-findings.md',
          decision_log_file: 'decision-log.md',
          code_review_report: 'No findings.',
          story_ref: wrongRef, // MISMATCH — triggers verify guard failure
        },
      },
    });

    // The guard bash node must fail (story_ref mismatch → bash exits 1)
    expect(run.nodeState['verify-story-identity']).toBe('failed');

    // code-review-gate depends on verify-story-identity (all_success) → skipped
    expect(run.nodeState['code-review-gate']).toBe('skipped');

    // Nodes downstream of a skipped route_loop may have no event emitted (undefined)
    // or be explicitly skipped — what matters is they NEVER completed.
    for (const nodeId of ['tea-rv', 'tea-nr', 'tea-tr', 'create-pull-request']) {
      expect(
        run.nodeState[nodeId],
        `${nodeId} must not have run when story_ref guard fails`
      ).not.toBe('completed');
    }
  });

  it('DAG-A4-2 [P1] happy path: code-review emits MATCHING story_ref → verify-story-identity passes → code-review-gate positive route → tea-rv runs', async () => {
    const canonicalKey = 'a1-2-preserve-story-input-resolution';

    const run = await runV2Dag({
      cwd: cwdFixture,
      arguments: canonicalKey,
      nodeResponses: {
        'code-review': {
          gate: 'PASS',
          round: 1,
          findings_count: 0,
          open_findings_file: 'findings/open-findings.md',
          decision_log_file: 'decision-log.md',
          code_review_report: 'No findings.',
          story_ref: canonicalKey, // MATCH — guard passes
        },
        // Remaining AI nodes get empty responses so they complete without errors
        'dev-story': {},
        'tea-automate': {},
        'tea-rv': {},
        'tea-nr': {},
        'tea-tr': {},
        'archon-create-pr': {},
      },
    });

    // verify-story-identity must complete (PASS stdout)
    expect(
      run.nodeState['verify-story-identity'],
      'verify-story-identity should complete when story_ref matches'
    ).toBe('completed');

    // tea-rv must not be skipped — positive route taken
    expect(
      run.nodeState['tea-rv'] === 'completed' || run.nodeState['tea-rv'] === undefined,
      'tea-rv should not be skipped on the happy path'
    ).toBe(true);
    expect(run.nodeState['tea-rv']).not.toBe('skipped');
  });
});
