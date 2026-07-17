import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
  setSystemTime,
  type Mock,
} from 'bun:test';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';

// --- Mock logger (MUST come before imports of modules under test) ---

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
// Hoisted telemetry mock — declared before the mock.module factory runs so the
// completion-telemetry tests can assert on it.
const mockCaptureWorkflowCompleted = mock(() => {});
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getWorkflowFolderSearchPaths: () => ['.archon/workflows'],
  getDefaultCommandsPath: () => '/nonexistent/defaults',
  getDefaultWorkflowsPath: () => '/nonexistent/defaults/workflows',
  getHomeWorkflowsPath: () => '/nonexistent/home/workflows',
  getLegacyHomeWorkflowsPath: () => '/nonexistent/home/.archon/workflows',
  getArchonHome: () => '/nonexistent/home',
  // Telemetry is fire-and-forget; mock as a no-op so terminal sites can call it.
  // Hoisted so tests can assert outcome / exit_reason at each terminal site.
  captureWorkflowCompleted: mockCaptureWorkflowCompleted,
}));

// --- Bootstrap provider registry (after path mocks, before dag-executor import) ---
import { registerBuiltinProviders, registerPiProvider, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();
// Pi is a community provider (best-effort structured output) — register it so the
// reask-loop tests can resolve `getProviderCapabilities('pi')` to 'best-effort'.
// deps.getAgentProvider is mocked, so the real Pi SDK is never loaded.
registerPiProvider();

// --- Imports (after mocks) ---
import {
  buildTopologicalLayers,
  checkTriggerRule,
  substituteNodeOutputRefs,
  substituteLoopPrevRefs,
  applyLoopPrevToBodyNode,
  executeDagWorkflow,
  collectContainerIncompatibleProviders,
  containerCommandName,
  buildSubprocessDockerArgs,
} from './dag-executor';
import { writeNodeArtifact } from './artifacts-index';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from './event-emitter';
import { loadMcpConfig } from '@archon/providers/mcp/config';
import type {
  DagNode,
  BashNode,
  ScriptNode,
  NodeOutput,
  WorkflowRun,
  WorkflowDefinition,
} from './schemas';
import { dagNodeSchema } from './schemas';
import { discoverWorkflows } from './workflow-discovery';
import { parseWorkflow } from './loader';
import { expandWorkflowIncludes } from './include-expander';
import { OutputRefError } from './output-ref';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import { buildAiProfile } from './model-validation';

// --- Mock helpers ---

function createMockStore(): IWorkflowStore {
  return {
    createWorkflowRun: mock(() =>
      Promise.resolve({
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        user_message: 'mock message',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
      })
    ),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() =>
      Promise.resolve({
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        user_message: 'mock message',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
      })
    ),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
    getWorkflowNodeSession: mock(() => Promise.resolve(null)),
    upsertWorkflowNodeSession: mock(() => Promise.resolve()),
    deleteWorkflowNodeSessions: mock(() => Promise.resolve({ deleted: 0 })),
  };
}

/** All-true capabilities for Claude mock */
const mockClaudeCapabilities = () => ({
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'enforced' as const,
  envInjection: true,
  costControl: true,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: true,
});
/** Limited capabilities for Codex mock */
const mockCodexCapabilities = () => ({
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: false,
  structuredOutput: 'enforced' as const,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
});

/** Mock AI sendQuery generator */
const mockSendQueryDag = mock(function* () {
  yield { type: 'assistant', content: 'DAG AI response' };
  yield { type: 'result', sessionId: 'dag-session-id' };
});

const mockGetAgentProviderDag = mock(() => ({
  sendQuery: mockSendQueryDag,
  getType: () => 'claude',
  getCapabilities: mockClaudeCapabilities,
}));

function createMockDeps(storeOverride?: IWorkflowStore): WorkflowDeps {
  const store = storeOverride ?? createMockStore();
  return {
    store,
    getAgentProvider: mockGetAgentProviderDag,
    loadConfig: mock(() =>
      Promise.resolve({
        assistant: 'claude' as const,
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        assistants: { claude: {}, codex: {} },
      })
    ),
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

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

// --- Helpers ---

function node(id: string, depends_on?: string[], opts?: Partial<DagNode>): DagNode {
  return { id, command: id, ...(depends_on?.length ? { depends_on } : {}), ...opts };
}

/**
 * Build a NodeOutput fixture for substitution tests.
 * Omits `structuredOutput` when undefined so the `'structuredOutput' in nodeOutput` presence
 * check in substituteNodeOutputRefs matches real producer behavior (Pi/Codex/Claude populate
 * it; older providers and the pending/skipped states leave it off).
 */
function makeOutput(
  state: NodeOutput['state'],
  output = '',
  structuredOutput?: unknown,
  declaredFields?: string[]
): NodeOutput {
  const extra = {
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(declaredFields !== undefined ? { declaredFields } : {}),
  };
  if (state === 'failed') {
    return { state, output, error: 'error', ...extra } as NodeOutput;
  }
  if (state === 'pending' || state === 'skipped') {
    return { state, output } as NodeOutput;
  }
  return { state, output, ...extra } as NodeOutput;
}

function makeWorkflowRun(id = 'dag-test-run-id', overrides?: Partial<WorkflowRun>): WorkflowRun {
  return {
    id,
    workflow_name: 'dag-test',
    conversation_id: 'conv-dag',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'dag test message',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    ...overrides,
  };
}

// --- Tests ---

describe('buildTopologicalLayers', () => {
  it('single node with no dependencies -> one layer', () => {
    const layers = buildTopologicalLayers([node('a')]);
    expect(layers).toHaveLength(1);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
  });

  it('linear chain -> one node per layer', () => {
    const layers = buildTopologicalLayers([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
    expect(layers[1].map(n => n.id)).toEqual(['b']);
    expect(layers[2].map(n => n.id)).toEqual(['c']);
  });

  it('fan-out: classify -> [investigate, plan] in same layer', () => {
    const layers = buildTopologicalLayers([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
    ]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    const layer1Ids = layers[1].map(n => n.id).sort();
    expect(layer1Ids).toEqual(['investigate', 'plan']);
  });

  it('fan-in: [a, b] -> implement in its own layer', () => {
    const layers = buildTopologicalLayers([node('a'), node('b'), node('implement', ['a', 'b'])]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'b']);
    expect(layers[1].map(n => n.id)).toEqual(['implement']);
  });

  it('diamond: classify -> [investigate, plan] -> implement', () => {
    const layers = buildTopologicalLayers([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
      node('implement', ['investigate', 'plan']),
    ]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['investigate', 'plan']);
    expect(layers[2].map(n => n.id)).toEqual(['implement']);
  });

  it('throws on cyclic graph (runtime safety check)', () => {
    const cyclic = [node('a', ['b']), node('b', ['a'])];
    expect(() => buildTopologicalLayers(cyclic)).toThrow('Cycle detected');
  });

  it('self-referential node throws', () => {
    const selfRef = [node('a', ['a'])];
    expect(() => buildTopologicalLayers(selfRef)).toThrow('Cycle detected');
  });

  it('two independent chains share layers correctly', () => {
    const layers = buildTopologicalLayers([
      node('a'),
      node('b', ['a']),
      node('c'),
      node('d', ['c']),
    ]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'c']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['b', 'd']);
  });
});

describe('checkTriggerRule', () => {
  it('all_success: runs when all deps completed', () => {
    const n = node('b', ['a']);
    const outputs = new Map([['a', makeOutput('completed')]]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_success: skips when one dep failed', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('failed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_success: skips when one dep skipped (skipped != success)', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('one_success: runs when at least one dep completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('failed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('one_success: skips when no deps completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('failed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('none_failed_min_one_success: runs with skipped branch and completed branch', () => {
    const n = node('implement', ['investigate', 'plan'], {
      trigger_rule: 'none_failed_min_one_success',
    });
    const outputs = new Map([
      ['investigate', makeOutput('skipped')],
      ['plan', makeOutput('completed')],
    ]);
    // skipped is not failed, plan succeeded -> run
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('none_failed_min_one_success: skips when one failed', () => {
    const n = node('implement', ['investigate', 'plan'], {
      trigger_rule: 'none_failed_min_one_success',
    });
    const outputs = new Map([
      ['investigate', makeOutput('failed')],
      ['plan', makeOutput('completed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_done: runs when all deps are in a terminal state', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'all_done' });
    const outputs = new Map([
      ['a', makeOutput('failed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_done: skips when a dep is still running', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'all_done' });
    const outputs = new Map([
      ['a', makeOutput('running')],
      ['b', makeOutput('completed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('no deps: always runs', () => {
    const n = node('a');
    const outputs = new Map<string, NodeOutput>();
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_success: skips when upstream absent from outputs (synthesised as failed)', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([['a', makeOutput('completed')]]);
    // 'b' is absent -> synthesised as failed -> all_success skips
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_done: runs when absent upstream is synthesised as failed (failed is terminal)', () => {
    const n = node('c', ['a'], { trigger_rule: 'all_done' });
    const outputs = new Map<string, NodeOutput>(); // 'a' absent -> synthesised as failed -> terminal
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });
});

describe('checkTriggerRule -- classify-gated pipeline behavior on failure', () => {
  it('all_success aspect skips when classify failed', () => {
    const aspect = node('code-review', ['review-classify']);
    const outputs = new Map([['review-classify', makeOutput('failed', '')]]);
    expect(checkTriggerRule(aspect, outputs)).toBe('skip');
  });

  it('one_success synthesize skips when all aspects skipped (classify failed)', () => {
    const synth = node('synthesize-review', ['code-review', 'error-handling', 'test-coverage'], {
      trigger_rule: 'one_success',
    });
    const outputs = new Map([
      ['code-review', makeOutput('skipped')],
      ['error-handling', makeOutput('skipped')],
      ['test-coverage', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(synth, outputs)).toBe('skip');
  });
});

describe('DAG Loader -- cycle detection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects cyclic DAG at load time', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'cyclic.yaml'),
      `
name: cyclic-dag
description: A cyclic dag
nodes:
  - id: a
    command: plan
    depends_on: [b]
  - id: b
    command: implement
    depends_on: [a]
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/cycle/i);
  });

  it('rejects unknown depends_on reference', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'bad-ref.yaml'),
      `
name: bad-ref
description: Bad dep ref
nodes:
  - id: a
    command: plan
    depends_on: [nonexistent]
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/nonexistent/);
  });

  it('rejects duplicate node IDs', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'dup-ids.yaml'),
      `
name: dup-ids
description: Duplicate node IDs
nodes:
  - id: a
    command: plan
  - id: a
    command: implement
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/duplicate/i);
  });

  it('rejects node with both command and prompt', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'both.yaml'),
      `
name: both-cmd-prompt
description: Both command and prompt
nodes:
  - id: a
    command: plan
    prompt: "do something"
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/mutually exclusive/i);
  });

  it('rejects node with neither command nor prompt', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'neither.yaml'),
      `
name: no-cmd-or-prompt
description: No command or prompt
nodes:
  - id: a
    depends_on: []
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/must have either/i);
  });

  it('accepts valid DAG with fan-out, when: conditions, and trigger_rule', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'valid.yaml'),
      `
name: classify-and-fix
description: Classify then fix or plan
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]
  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"
  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"
  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0].workflow;
    expect(wf.nodes).toHaveLength(4);
    expect(wf.nodes[0].id).toBe('classify');
    expect(wf.nodes[0].output_format).toBeDefined();
    expect(wf.nodes[1].when).toBe("$classify.output.type == 'BUG'");
    expect(wf.nodes[3].trigger_rule).toBe('none_failed_min_one_success');
  });

  it('accepts inline prompt nodes', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'inline-prompt.yaml'),
      `
name: inline-prompts
description: DAG with inline prompts
nodes:
  - id: step-a
    prompt: "Output exactly: hello from A"
  - id: step-b
    prompt: "Output exactly: hello from B"
    depends_on: [step-a]
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0].workflow;
    expect(wf.nodes).toBeDefined();
    expect(wf.nodes[0].prompt).toBe('Output exactly: hello from A');
    expect(wf.nodes[1].depends_on).toEqual(['step-a']);
  });

  it('ignores unknown top-level fields when valid nodes: is present', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'nodes-extra.yaml'),
      `
name: extra-fields
description: Has extra top-level fields that are ignored
nodes:
  - id: a
    command: plan
loop:
  until: COMPLETE
  max_iterations: 5
prompt: "do something"
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].workflow.name).toBe('extra-fields');
  });

  it('rejects node with invalid trigger_rule', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'bad-rule.yaml'),
      `
name: bad-trigger-rule
description: Invalid trigger rule
nodes:
  - id: a
    command: plan
  - id: b
    command: implement
    depends_on: [a]
    trigger_rule: all-success
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/trigger_rule/i);
  });

  it('parses allowed_tools and denied_tools on DAG nodes', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'tool-restrictions.yaml'),
      `
name: tool-restriction-test
description: Test tool restrictions
nodes:
  - id: review
    command: code-review
    allowed_tools: [Read, Grep, Glob]
  - id: implement
    command: implement-feature
    denied_tools: [WebSearch, WebFetch]
  - id: mcp-only
    command: mcp-command
    allowed_tools: []
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    const wf = result.workflows
      .map(ws => ws.workflow)
      .find(w => w.name === 'tool-restriction-test');
    expect(wf).toBeDefined();
    if (!wf) return;

    expect(wf.nodes[0].allowed_tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(wf.nodes[0].denied_tools).toBeUndefined();

    expect(wf.nodes[1].denied_tools).toEqual(['WebSearch', 'WebFetch']);
    expect(wf.nodes[1].allowed_tools).toBeUndefined();

    // Empty array must be preserved (distinct from absent)
    expect(wf.nodes[2].allowed_tools).toEqual([]);
  });
});

describe('substituteNodeOutputRefs', () => {
  it('replaces $nodeId.output with node output text', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello')]]);
    expect(substituteNodeOutputRefs('Result: $a.output', outputs)).toBe('Result: hello');
  });

  it('unknown node ref resolves to empty string and logs a warning', () => {
    mockLogFn.mockClear();
    const outputs = new Map<string, NodeOutput>();
    expect(substituteNodeOutputRefs('Result: $missing.output', outputs)).toBe('Result: ');
    const warnCalls = mockLogFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'dag_node_output_ref_unknown_node'
    );
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0][0]).toEqual(expect.objectContaining({ nodeId: 'missing' }));
  });

  it('dot notation extracts JSON field', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ type: 'BUG' }))]]);
    expect(substituteNodeOutputRefs('Fix $a.output.type issue', outputs)).toBe('Fix BUG issue');
  });

  it('dot notation on invalid JSON throws (no-silent-drop)', () => {
    // Schemaless node, output is not a JSON object → a `.field` ref is a drop the
    // author must see. Throws (propagates to fail the consuming node) instead of ''.
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(() => substituteNodeOutputRefs('$a.output.field', outputs)).toThrow(OutputRefError);
  });

  it('declared-optional field absent resolves to empty (the one non-throw case)', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', '{"type":"BUG"}', { type: 'BUG' }, ['type', 'note'])],
    ]);
    expect(substituteNodeOutputRefs('$a.output.note', outputs)).toBe('');
  });

  it('field not in the declared schema throws (typo)', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', '{"type":"BUG"}', { type: 'BUG' }, ['type'])],
    ]);
    expect(() => substituteNodeOutputRefs('$a.output.tpye', outputs)).toThrow(OutputRefError);
  });

  it('schemaless JSON node missing a referenced key throws', () => {
    const outputs = new Map([['a', makeOutput('completed', '{"type":"BUG"}')]]);
    expect(() => substituteNodeOutputRefs('$a.output.missing', outputs)).toThrow(OutputRefError);
  });

  it('unknown node ref WITH a field throws (no-silent-drop, unknown-node)', () => {
    // The whole-text `$missing.output` form stays lenient ('' — see test above), but a
    // `.field` ref to an unknown id is a typo the load-time validator can't always see
    // (bash/script/approval/cancel + command-file refs aren't scanned). It must fail the
    // consuming node loudly, matching known-producer strict-field posture.
    const outputs = new Map([['analyze', makeOutput('completed', '{"type":"BUG"}')]]);
    let caught: unknown;
    try {
      substituteNodeOutputRefs('Fix $analze.output.type', outputs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutputRefError);
    expect((caught as OutputRefError).reason).toBe('unknown-node');
    // did-you-mean names the near miss.
    expect((caught as OutputRefError).message).toContain("'analyze'");
  });

  it('unknown node ref WITH a field throws even in bash-escaped mode', () => {
    const outputs = new Map<string, NodeOutput>();
    expect(() => substituteNodeOutputRefs('echo $missing.output.field', outputs, true)).toThrow(
      OutputRefError
    );
  });
});

describe('substituteNodeOutputRefs -- shell escaping', () => {
  it('does not escape by default (AI prompt substitution)', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello; rm -rf /')]]);
    expect(substituteNodeOutputRefs('Result: $a.output', outputs)).toBe('Result: hello; rm -rf /');
  });

  it('shell-quotes output when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello world')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'hello world'");
  });

  it('escapes shell metacharacters when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello; rm -rf /')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe(
      "echo 'hello; rm -rf /'"
    );
  });

  it('escapes single quotes inside output when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', "it's alive")]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'it'\\''s alive'");
  });

  it('missing ref becomes empty string when escapedForBash=true', () => {
    const outputs = new Map<string, NodeOutput>();
    expect(substituteNodeOutputRefs('echo $missing.output', outputs, true)).toBe("echo ''");
  });

  it('JSON field escapes shell metacharacters when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ cmd: 'foo; bar' }))]]);
    expect(substituteNodeOutputRefs('echo $a.output.cmd', outputs, true)).toBe("echo 'foo; bar'");
  });

  it('numeric JSON field is not quoted (safe as-is)', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ count: 42 }))]]);
    expect(substituteNodeOutputRefs('exit $a.output.count', outputs, true)).toBe('exit 42');
  });

  it('boolean JSON field is not quoted (safe as-is)', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ ok: true }))]]);
    expect(substituteNodeOutputRefs('[ $a.output.ok ]', outputs, true)).toBe('[ true ]');
  });

  it('empty string output becomes quoted empty string when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', '')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo ''");
  });

  it('embedded newline in output is safe when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello\nworld')]]);
    // Single-quoted bash strings can contain literal newlines safely
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'hello\nworld'");
  });

  it('object JSON field becomes JSON stringified when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ nested: { x: 1 } }))]]);
    expect(substituteNodeOutputRefs('echo $a.output.nested', outputs, true)).toBe(
      'echo \'{"x":1}\''
    );
  });

  it('array JSON field becomes JSON stringified', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: ['todo', 'fix'] }))],
    ]);
    expect(substituteNodeOutputRefs('$a.output.items', outputs)).toBe('["todo","fix"]');
  });

  it('array JSON field is shell-quoted when escapedForBash=true', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: ['todo', 'fix'] }))],
    ]);
    expect(substituteNodeOutputRefs('echo $a.output.items', outputs, true)).toBe(
      'echo \'["todo","fix"]\''
    );
  });

  it('nested object in array field becomes JSON stringified', () => {
    const outputs = new Map([
      [
        'a',
        makeOutput('completed', JSON.stringify({ files: [{ name: 'a.ts', status: 'modified' }] })),
      ],
    ]);
    expect(substituteNodeOutputRefs('$a.output.files', outputs)).toBe(
      '[{"name":"a.ts","status":"modified"}]'
    );
  });

  it('null values in arrays stringify to "null"', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: [null, 'ok'] }))],
    ]);
    expect(substituteNodeOutputRefs('$a.output.items', outputs)).toBe('[null,"ok"]');
  });

  it('null object field becomes JSON stringified "null"', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ config: null }))]]);
    expect(substituteNodeOutputRefs('$a.output.config', outputs)).toBe('null');
  });

  it('dot notation on invalid JSON throws even when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(() => substituteNodeOutputRefs('$a.output.field', outputs, true)).toThrow(
      OutputRefError
    );
  });
});

describe('substituteNodeOutputRefs -- large output file substitution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `archon-test-large-output-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('inlines small output even when outputFileDir is provided', () => {
    const outputs = new Map([['a', makeOutput('completed', 'small')]]);
    const result = substituteNodeOutputRefs('echo $a.output', outputs, true, tempDir);
    expect(result).toBe("echo 'small'");
  });

  it('writes large output (>=32KB) to file and returns $(cat ...) reference', async () => {
    const largeOutput = 'x'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', largeOutput)]]);
    const result = substituteNodeOutputRefs('echo $a.output', outputs, true, tempDir);
    expect(result).toContain('$(cat ');
    expect(result).toContain('a.nodeoutput');
    // Verify file was written with correct content
    const { readFile: readFileAsync } = await import('fs/promises');
    const written = await readFileAsync(join(tempDir, 'a.nodeoutput'), 'utf-8');
    expect(written).toBe(largeOutput);
  });

  it('writes large field value to file with field name in filename', async () => {
    const largeValue = 'y'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ data: largeValue }))]]);
    const result = substituteNodeOutputRefs('echo $a.output.data', outputs, true, tempDir);
    expect(result).toContain('$(cat ');
    expect(result).toContain('a.data.nodeoutput');
    const { readFile: readFileAsync } = await import('fs/promises');
    const written = await readFileAsync(join(tempDir, 'a.data.nodeoutput'), 'utf-8');
    expect(written).toBe(largeValue);
  });

  it('does not write to file when escapedForBash=false even for large output', () => {
    const largeOutput = 'x'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', largeOutput)]]);
    const result = substituteNodeOutputRefs('echo $a.output', outputs, false, tempDir);
    expect(result).toBe(`echo ${largeOutput}`);
    expect(result).not.toContain('$(cat ');
  });

  it('falls back to shell-quoting when file write fails', () => {
    const largeOutput = 'x'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', largeOutput)]]);
    // Use a non-existent directory to trigger writeFileSync failure
    const badDir = '/nonexistent-path-that-does-not-exist';
    const result = substituteNodeOutputRefs('echo $a.output', outputs, true, badDir);
    // Should fall back to inline shell-quoting instead of crashing
    expect(result).not.toContain('$(cat ');
    expect(result).toBe(`echo '${largeOutput}'`);
  });
});

describe('substituteNodeOutputRefs -- structuredOutput preference', () => {
  it('prefers structuredOutput.field over JSON.parse(output)', () => {
    // Pi-shape: prose output text with structuredOutput populated by tryParseStructuredOutput.
    const outputs = new Map([
      [
        'classify',
        makeOutput('completed', 'Here is the classification: {"type":"WRONG"}', {
          type: 'BUG',
          confidence: 0.9,
        }),
      ],
    ]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe(
      'Fix BUG issue'
    );
  });

  it('falls back to JSON.parse(output) when structuredOutput is absent', () => {
    // Claude/Codex backward-compat regression: no structuredOutput, JSON in `output`.
    const outputs = new Map([
      ['classify', makeOutput('completed', JSON.stringify({ type: 'BUG' }))],
    ]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe(
      'Fix BUG issue'
    );
  });

  it('coerces structuredOutput numeric field to string', () => {
    const outputs = new Map([['score', makeOutput('completed', '', { confidence: 0.95 })]]);
    expect(substituteNodeOutputRefs('score=$score.output.confidence', outputs)).toBe('score=0.95');
  });

  it('coerces structuredOutput boolean field to string', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { ok: true })]]);
    expect(substituteNodeOutputRefs('[ $n.output.ok ]', outputs)).toBe('[ true ]');
  });

  it('JSON-stringifies object structuredOutput field', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { nested: { x: 1 } })]]);
    expect(substituteNodeOutputRefs('$n.output.nested', outputs)).toBe('{"x":1}');
  });

  it('JSON-stringifies array structuredOutput field', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { items: ['todo', 'fix'] })]]);
    expect(substituteNodeOutputRefs('$n.output.items', outputs)).toBe('["todo","fix"]');
  });

  it('works with empty output text (Pi-only-structured case)', () => {
    // structuredOutput populated, output text empty → dot-access still works.
    const outputs = new Map([['classify', makeOutput('completed', '', { type: 'BUG' })]]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe(
      'Fix BUG issue'
    );
  });

  it('null structuredOutput falls through to JSON.parse fallback', () => {
    const outputs = new Map([
      ['n', makeOutput('completed', JSON.stringify({ type: 'BUG' }), null)],
    ]);
    expect(substituteNodeOutputRefs('$n.output.type', outputs)).toBe('BUG');
  });

  it('top-level-array structuredOutput falls through to JSON.parse fallback', () => {
    const outputs = new Map([
      ['n', makeOutput('completed', JSON.stringify({ type: 'BUG' }), [1, 2, 3])],
    ]);
    expect(substituteNodeOutputRefs('$n.output.type', outputs)).toBe('BUG');
  });

  it('primitive structuredOutput falls through to JSON.parse fallback', () => {
    const outputs = new Map([
      ['n', makeOutput('completed', JSON.stringify({ type: 'BUG' }), 'just-a-string')],
    ]);
    expect(substituteNodeOutputRefs('$n.output.type', outputs)).toBe('BUG');
  });

  it('missing field in structuredOutput resolves to empty string (no JSON.parse retry)', () => {
    // structuredOutput is authoritative; if the field is missing, do not retry output.
    const outputs = new Map([
      ['classify', makeOutput('completed', JSON.stringify({ type: 'BUG' }), { confidence: 0.9 })],
    ]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe('Fix  issue');
  });

  it('bare $node.output reference (no field) uses output text, not structuredOutput', () => {
    const outputs = new Map([['n', makeOutput('completed', 'prose text', { type: 'BUG' })]]);
    expect(substituteNodeOutputRefs('Got: $n.output', outputs)).toBe('Got: prose text');
  });

  it('structuredOutput field is shell-quoted when escapedForBash=true', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { cmd: 'foo; bar' })]]);
    expect(substituteNodeOutputRefs('echo $n.output.cmd', outputs, true)).toBe("echo 'foo; bar'");
  });
});

describe('checkTriggerRule -- missing upstream treated as failed', () => {
  it('none_failed_min_one_success: skips when all deps skipped (no success)', () => {
    const n = node('implement', ['a', 'b'], { trigger_rule: 'none_failed_min_one_success' });
    const outputs = new Map([
      ['a', makeOutput('skipped')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_success: node with skipped dep is skipped, so anyCompleted stays false', () => {
    const n = node('b', ['a']);
    const outputs = new Map([['a', makeOutput('skipped')]]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });
});

describe('executeDagWorkflow -- tool restrictions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  afterEach(async () => {
    // Restore default claude client
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes allowed_tools to sendQuery options for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-tool-restriction',
        nodes: [{ id: 'review', command: 'my-cmd', allowed_tools: ['Read', 'Grep'] }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('routes Codex tier effort to assistantConfig.modelReasoningEffort', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        medium: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'codex-tier-effort-test',
        nodes: [{ id: 'step1', command: 'my-cmd', model: 'medium' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      aiProfile
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('codex');
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('gpt-5.5');
    const assistantConfig = optionsArg.assistantConfig as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(assistantConfig.modelReasoningEffort).toBe('medium');
    expect(nodeConfig.effort).toBeUndefined();
  });

  it('applies inherited workflow tier effort to nodes without model overrides', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const workflowPreset = { provider: 'codex', model: 'gpt-5.5', effort: 'high' };
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        large: workflowPreset,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'inherited-workflow-tier-test',
        nodes: [{ id: 'step1', command: 'my-cmd' }],
      },
      workflowRun,
      'codex',
      'gpt-5.5',
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      aiProfile,
      workflowPreset
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('codex');
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('gpt-5.5');
    const assistantConfig = optionsArg.assistantConfig as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(assistantConfig.modelReasoningEffort).toBe('high');
    expect(nodeConfig.effort).toBeUndefined();
  });

  it('routes Claude tier effort to nodeConfig.effort', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        large: { provider: 'claude', model: 'opus', effort: 'max' },
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'claude-tier-effort-test',
        nodes: [{ id: 'step1', command: 'my-cmd', model: 'large' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      aiProfile
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('opus');
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(nodeConfig.effort).toBe('max');

    // Verify that the node_started event carries the resolved tier and model.
    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall).toBeDefined();
    expect(nodeStartedCall?.[0].data?.tier).toBe('large');
    expect(nodeStartedCall?.[0].data?.model).toBe('opus');
  });

  it('surfaces the workflow-level tier on nodes that inherit the workflow model', async () => {
    // Regression guard for #2036: the bundled default workflows set the tier at
    // the WORKFLOW level (e.g. `model: medium`), and their nodes have no own
    // `model`. The node_started event must still carry the inherited tier.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'workflow-level-tier-test',
        model: 'medium',
        nodes: [{ id: 'step1', command: 'my-cmd' }],
      },
      workflowRun,
      'claude',
      'sonnet', // executor resolves the workflow-level `medium` -> `sonnet`
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      aiProfile
    );

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall).toBeDefined();
    expect(nodeStartedCall?.[0].data?.tier).toBe('medium');
    expect(nodeStartedCall?.[0].data?.model).toBe('sonnet');
  });

  it('passes literal node model through unchanged', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'literal-model-test',
        nodes: [{ id: 'step1', command: 'my-cmd', provider: 'claude', model: 'opus' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      aiProfile
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('claude');
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('opus');
  });

  it('warns when explicit node provider conflicts with alias provider and alias wins', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoAliases: {
        '@fast': { provider: 'codex', model: 'gpt-5.5', effort: 'minimal' },
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'alias-provider-conflict-test',
        nodes: [{ id: 'step1', command: 'my-cmd', provider: 'claude', model: '@fast' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      aiProfile
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('codex');
    expect(
      platform.sendMessage.mock.calls.some(call =>
        String(call[1]).includes(
          "sets provider 'claude' but model '@fast' resolves to provider 'codex'"
        )
      )
    ).toBe(true);
  });

  it('warns user when Codex DAG node has denied_tools only', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-denied',
        nodes: [
          { id: 'review', command: 'my-cmd', provider: 'codex', denied_tools: ['WebSearch'] },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(
      m => m.includes('allowed_tools/denied_tools') && m.includes('codex')
    );
    expect(warning).toBeDefined();
  });

  it('passes empty allowed_tools: [] (disable all tools) to sendQuery', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-empty-tools', nodes: [{ id: 'review', command: 'my-cmd', allowed_tools: [] }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.allowed_tools).toEqual([]);
  });

  it('passes hooks to sendQuery options for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-hooks',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            hooks: {
              PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }],
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.hooks).toBeDefined();
    const hooks = nodeConfig?.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it('warns user when Codex DAG node has hooks', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-hooks',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            provider: 'codex',
            hooks: {
              PreToolUse: [{ response: { decision: 'block' } }],
            },
          },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('hooks') && m.includes('codex'));
    expect(warning).toBeDefined();
  });
});

describe('executeDagWorkflow -- bash nodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-bash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('bash node executes and captures stdout as output', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: BashNode = {
      id: 'stats',
      bash: 'echo "hello world"',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-exec-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Bash node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('bash node stdout is available for downstream $nodeId.output substitution', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    // Write a command file for the downstream AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Process: $stats.output');

    const nodes: DagNode[] = [
      { id: 'stats', bash: 'echo "42 files"' },
      { id: 'process', command: 'my-cmd', depends_on: ['stats'] },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-subst-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI client should have been called for the downstream node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The prompt should contain the substituted bash output
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain('42 files');
  });

  it('non-zero exit code results in failed state', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: BashNode = {
      id: 'fail',
      bash: 'exit 1',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-fail-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The workflow should complete (it handles failures) but the node failed
    // The mock platform should have received a failure message about the failed node
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('failed') && m.includes('fail'));
    expect(failMsg).toBeDefined();
  });

  it('failure message surfaces stderr and does not leak the "Command failed: bash -c <body>" prefix', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-1389-run-id', {
      workflow_name: 'bash-1389',
      conversation_id: 'conv-1389b',
      user_message: 'test',
    });

    // Marker is echoed to stdout only (so it lands in the command line embedded
    // in err.message but never in stderr). If it shows up in errorMsg the
    // prefix line was not stripped.
    const bashNode: BashNode = {
      id: 'fail-bash-1389',
      bash: 'echo UNIQUE_CMDLINE_MARKER_1389; echo "diagnostic from stderr" >&2; exit 1',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-1389b',
      testDir,
      { name: 'bash-1389', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'fail-bash-1389'
    );
    expect(failedEvent).toBeDefined();
    const errorMsg = (failedEvent![0] as { data: { error: string } }).data.error;
    expect(errorMsg).toContain("Bash node 'fail-bash-1389' failed");
    expect(errorMsg).toContain('[exit 1]');
    expect(errorMsg).not.toContain('Command failed:');
    expect(errorMsg).not.toContain('UNIQUE_CMDLINE_MARKER_1389');
    expect(errorMsg).toContain('diagnostic from stderr');
  });

  it('variable substitution works in bash scripts', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: BashNode = {
      id: 'vars',
      bash: 'echo "$ARGUMENTS"',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-vars-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Should complete without error (no AI calls)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('bash node in parallel layer executes correctly', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    // Write a command file for the AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something');

    const nodes: DagNode[] = [
      { id: 'bash-a', bash: 'echo "from bash"' },
      { id: 'ai-b', command: 'my-cmd' },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-parallel-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI client called only for the AI node, not the bash node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('passes config.envVars to bash subprocesses', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-env-run-id');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash-env',
      testDir,
      { name: 'bash-env-test', nodes: [{ id: 'stats', bash: 'echo ok' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } }
    );

    expect(execSpy).toHaveBeenCalledWith(
      git.resolveBashPath(),
      ['-c', 'echo ok'],
      expect.objectContaining({
        env: expect.objectContaining({ MY_SECRET: 'abc123' }),
      })
    );
    execSpy.mockRestore();
  });

  it('bash node output with shell metacharacters does not inject into downstream bash script', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-injection-run-id', {
      workflow_name: 'bash-injection-test',
      conversation_id: 'conv-injection',
      user_message: 'test',
    });

    // upstream: outputs a value containing shell metacharacters
    // downstream: embeds $upstream.output literally in a bash script
    // If injection were present, the semicolon would split into two commands and INJECTED would print
    const nodes: DagNode[] = [
      { id: 'upstream', bash: 'printf "%s" "safe; echo INJECTED"' },
      {
        id: 'downstream',
        bash: 'result=$upstream.output; echo "got: $result"',
        depends_on: ['upstream'],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-injection',
      testDir,
      { name: 'bash-injection-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // No AI calls
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // The downstream node ran without injection: stdout should contain the literal value, not a separate INJECTED line
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    // 'INJECTED' as a standalone result of injection must not appear
    const injectedMessage = messages.find((m: string) => m === 'INJECTED');
    expect(injectedMessage).toBeUndefined();
  });

  it('passes user message through env vars, not string substitution, preventing shell injection', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('bash-shell-safe-run-id', {
        workflow_name: 'bash-shell-safe',
        conversation_id: 'conv-shell-safe',
        user_message: '$(rm -rf /)',
      });

      const bashNode: BashNode = {
        id: 'safe',
        bash: 'echo $USER_MESSAGE',
      };

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-shell-safe',
        testDir,
        { name: 'bash-shell-safe-test', nodes: [bashNode] },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(execSpy).toHaveBeenCalledTimes(1);
      const firstCall = execSpy.mock.calls[0];

      // The script passed to bash -c must contain literal $USER_MESSAGE (not substituted)
      const bashArgs = firstCall?.[1] as string[];
      expect(bashArgs[1]).toBe('echo $USER_MESSAGE');

      // The env must contain the user message
      const envArg = (firstCall?.[2] as { env: NodeJS.ProcessEnv }).env;
      expect(envArg?.USER_MESSAGE).toBe('$(rm -rf /)');
      expect(envArg?.ARGUMENTS).toBe('$(rm -rf /)');
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe('executeDagWorkflow -- output_format structured output', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-output-fmt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'classify.md'), 'Classify this: $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('uses structuredOutput from result when output_format is set', async () => {
    const structuredJson = { run_code_review: 'true', run_tests: 'false' };

    // Mock yields prose + JSON as assistant text, then result with structuredOutput
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Let me analyze the PR scope...\n' };
      yield { type: 'assistant', content: JSON.stringify(structuredJson) };
      yield { type: 'result', sessionId: 'sid-1', structuredOutput: structuredJson };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('output-fmt-run', {
      user_message: 'classify this PR',
    });

    const nodes: DagNode[] = [
      {
        id: 'classify',
        command: 'classify',
        output_format: {
          type: 'object',
          properties: {
            run_code_review: { type: 'string', enum: ['true', 'false'] },
            run_tests: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      {
        id: 'review',
        prompt: 'Review the code',
        depends_on: ['classify'],
        when: "$classify.output.run_code_review == 'true'",
      },
      {
        id: 'test',
        prompt: 'Run tests',
        depends_on: ['classify'],
        when: "$classify.output.run_tests == 'true'",
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-output-fmt',
      testDir,
      { name: 'output-fmt-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The review node's when condition should evaluate to true (run_code_review == 'true')
    // The test node's when condition should evaluate to false (run_tests == 'false', not 'true')
    // So sendQuery should be called for classify + review = 2 times (not 3)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
  });

  it('does NOT override nodeOutputText with structuredOutput when output_format is absent', async () => {
    // Even if the SDK returns structuredOutput, nodes without output_format use concatenated text
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'prose analysis text' };
      yield { type: 'result', sessionId: 'sid-no-fmt', structuredOutput: { type: 'BUG' } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('no-output-fmt-run', {
      user_message: 'test guard',
    });

    const nodes: DagNode[] = [
      { id: 'a', command: 'classify' },
      {
        id: 'b',
        prompt: 'Got: $a.output',
        depends_on: ['a'],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-no-fmt',
      testDir,
      { name: 'no-fmt-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Second node's prompt should contain the concatenated prose, not the JSON
    const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(secondCallPrompt).toContain('prose analysis text');
    expect(secondCallPrompt).not.toContain('"type"');
  });

  it('falls back to concatenated text when structuredOutput is absent', async () => {
    // Mock without structuredOutput on result — backward compatible
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'plain text response' };
      yield { type: 'result', sessionId: 'sid-2' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('no-structured-run', {
      user_message: 'test fallback',
    });

    const nodes: DagNode[] = [
      { id: 'a', command: 'classify' },
      {
        id: 'b',
        prompt: 'Use output: $a.output',
        depends_on: ['a'],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-fallback',
      testDir,
      { name: 'fallback-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Both nodes should execute (no output_format, no when conditions)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Second node's prompt should contain the concatenated text from node a
    const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(secondCallPrompt).toContain('plain text response');
  });

  it('passes outputFormat to Codex nodes and uses inline JSON response', async () => {
    // Codex provider normalizes inline JSON into structuredOutput on the result chunk
    const classifyJson = { run_code_review: 'true', run_tests: 'false' };
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: JSON.stringify(classifyJson) };
      yield { type: 'result', sessionId: 'codex-sid-1', structuredOutput: classifyJson };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('codex-output-fmt-run', {
      user_message: 'classify this PR',
    });

    const nodes: DagNode[] = [
      {
        id: 'classify',
        command: 'classify',
        output_format: {
          type: 'object',
          properties: {
            run_code_review: { type: 'string', enum: ['true', 'false'] },
            run_tests: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      {
        id: 'review',
        prompt: 'Review the code',
        depends_on: ['classify'],
        when: "$classify.output.run_code_review == 'true'",
      },
      {
        id: 'test',
        prompt: 'Run tests',
        depends_on: ['classify'],
        when: "$classify.output.run_tests == 'true'",
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-codex-fmt',
      testDir,
      { name: 'codex-output-fmt', nodes },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // classify + review = 2 calls (test node skipped because run_tests == 'false')
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Verify outputFormat was passed to the Codex client (4th arg = options)
    const classifyOptions = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(classifyOptions.outputFormat).toEqual({
      type: 'json_schema',
      schema: nodes[0].output_format,
    });
  });

  it('does not warn about missing structuredOutput for Codex nodes', async () => {
    // Codex provider normalizes inline JSON into structuredOutput on the result chunk
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: '{"status":"ok"}' };
      yield { type: 'result', sessionId: 'codex-sid-2', structuredOutput: { status: 'ok' } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('codex-no-warn-run', {
      user_message: 'check it',
    });

    const nodes: DagNode[] = [
      {
        id: 'check',
        command: 'classify',
        output_format: { type: 'object', properties: { status: { type: 'string' } } },
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-codex-no-warn',
      testDir,
      { name: 'codex-no-warn', nodes },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Verify no "structured output missing" warning was sent to the user
    const sendCalls = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock
      .calls;
    const warningMessages = sendCalls
      .map(call => call[1] as string)
      .filter(msg => typeof msg === 'string' && msg.includes('did not return structured output'));
    expect(warningMessages).toHaveLength(0);
  });
});

describe('executeDagWorkflow -- when condition parse errors (fail-closed)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-parse-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'sess-parse-err' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('skips node (does not run it) when when: expression is unparseable', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-skip-run');

    const nodes: DagNode[] = [
      { id: 'unconditional', command: 'my-cmd' },
      // Single = is not valid syntax — will fail to parse
      {
        id: 'guarded',
        command: 'my-cmd',
        depends_on: ['unconditional'],
        when: "$unconditional.output = 'yes'",
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-parse-err-skip',
      testDir,
      { name: 'parse-err-skip-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Only the unconditional node should have triggered an AI call.
    // The guarded node must be skipped (fail-closed), not executed.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('sends a platform warning message naming the node and stating it was skipped', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-warn-run');

    const nodes: DagNode[] = [{ id: 'gate', command: 'my-cmd', when: 'not a valid condition' }];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-parse-err-warn',
      testDir,
      { name: 'parse-warn-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('gate') && m.includes('skipped'));
    expect(warning).toBeDefined();
    // Must NOT indicate the node ran (the old fail-open behavior)
    expect(warning).not.toMatch(/node ran/i);
  });

  it('workflow completes without throwing when all nodes are skipped via parse error', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-all-skip-run');

    const nodes: DagNode[] = [{ id: 'only', command: 'my-cmd', when: 'bad expression' }];

    await expect(
      executeDagWorkflow(
        mockDeps,
        platform,
        'conv-all-skipped',
        testDir,
        { name: 'all-skipped-test', nodes },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      )
    ).resolves.toBeUndefined();
  });
});

describe('executeDagWorkflow -- node-level retry for transient errors', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('node succeeds on retry after a transient error', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        throw new Error('Claude Code crash: process exited with code 1');
      }
      yield { type: 'assistant', content: 'Recovered' };
      yield { type: 'result', sessionId: 'retry-sess' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-succeed-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-succeed',
      testDir,
      { name: 'dag-retry-succeed', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Node was called at least twice (first fails transiently, second succeeds)
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).not.toHaveBeenCalled();
  }, 5_000);

  it('workflow fails after exhausting all node retries', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      throw new Error('Claude Code crash: process exited with code 1');
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-exhaust-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-exhaust',
      testDir,
      { name: 'dag-retry-exhaust', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // max_attempts: 2 = 2 retries → 3 total attempts (delay_ms: 1 keeps test fast)
    expect(callCount).toBe(3);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  }, 5_000);

  it('node with FATAL error does not retry (call count = 1)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      throw new Error('Claude Code auth error: unauthorized');
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-fatal-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-fatal',
      testDir,
      { name: 'dag-retry-fatal', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // FATAL error must not be retried — exactly 1 attempt
    expect(callCount).toBe(1);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  });

  it('sends retry notification to platform before each delay', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        throw new Error('Claude Code crash: process exited with code 1');
      }
      yield { type: 'assistant', content: 'OK' };
      yield { type: 'result', sessionId: 'ok-sess' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-notify-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-notify',
      testDir,
      { name: 'dag-retry-notify', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls;
    const retryMessages = sendCalls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'string' && (call[1] as string).includes('transient error')
    );
    expect(retryMessages.length).toBeGreaterThan(0);
  }, 5_000);
});

describe('executeDagWorkflow -- retry on deterministic (bash/script) nodes (#2088)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-det-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Deterministic nodes run real subprocesses, so a side-effect counter file is
  // the most direct way to observe how many attempts actually happened.
  async function runNodes(
    nodes: DagNode[]
  ): Promise<{ mockDeps: WorkflowDeps; platform: IWorkflowPlatform }> {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('det-retry-run', {
      workflow_name: 'det-retry',
      conversation_id: 'conv-det-retry',
      user_message: 'det retry message',
    });
    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-det-retry',
      testDir,
      { name: 'det-retry', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );
    return { mockDeps, platform };
  }

  it('bash node with retry re-runs until it succeeds', async () => {
    // Forward-slashed for safe embedding in inline bash AND JS string literals
    // (Windows join() yields backslashes; '\a' is an escape in JS strings).
    const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
    const marker = join(testDir, 'marker');
    const nodes: DagNode[] = [
      {
        id: 'flaky',
        // Attempt 1: no marker → create it, fail. Attempt 2: marker present → succeed.
        bash: `printf 'a' >> '${attempts}'; if [ -e '${marker}' ]; then echo ok; else printf x > '${marker}'; echo 'boom' >&2; exit 1; fi`,
        retry: { max_attempts: 3, delay_ms: 1, on_error: 'all' },
      },
    ];
    const { mockDeps } = await runNodes(nodes);

    const content = await readFile(attempts, 'utf8');
    // One failing attempt then one succeeding attempt → exactly 2 runs.
    expect(content.length).toBe(2);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).not.toHaveBeenCalled();
  }, 5_000);

  it('bash node with retry exhausts all attempts on persistent failure', async () => {
    // Forward-slashed for safe embedding in inline bash AND JS string literals
    // (Windows join() yields backslashes; '\a' is an escape in JS strings).
    const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
    const nodes: DagNode[] = [
      {
        id: 'always-fails',
        bash: `printf 'a' >> '${attempts}'; echo 'boom' >&2; exit 1`,
        retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
      },
    ];
    const { mockDeps } = await runNodes(nodes);

    const content = await readFile(attempts, 'utf8');
    // max_attempts: 2 = 2 retries → 3 total attempts. Without the fix this is 1.
    expect(content.length).toBe(3);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  }, 5_000);

  it('bash node WITHOUT a retry block runs exactly once (single-attempt default preserved)', async () => {
    // Forward-slashed for safe embedding in inline bash AND JS string literals
    // (Windows join() yields backslashes; '\a' is an escape in JS strings).
    const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
    const nodes: DagNode[] = [
      {
        id: 'no-retry',
        bash: `printf 'a' >> '${attempts}'; echo 'boom' >&2; exit 1`,
      },
    ];
    const { mockDeps } = await runNodes(nodes);

    const content = await readFile(attempts, 'utf8');
    // Deterministic nodes never auto-retry — retry is opt-in via an explicit block.
    expect(content.length).toBe(1);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  }, 5_000);

  it('bash node with a FATAL error is never retried even with on_error: all', async () => {
    // Forward-slashed for safe embedding in inline bash AND JS string literals
    // (Windows join() yields backslashes; '\a' is an escape in JS strings).
    const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
    const nodes: DagNode[] = [
      {
        id: 'fatal',
        bash: `printf 'a' >> '${attempts}'; echo 'unauthorized' >&2; exit 1`,
        retry: { max_attempts: 3, delay_ms: 1, on_error: 'all' },
      },
    ];
    const { mockDeps } = await runNodes(nodes);

    const content = await readFile(attempts, 'utf8');
    // FATAL classification wins over on_error: all → exactly 1 attempt.
    expect(content.length).toBe(1);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  }, 5_000);

  it('script node with retry re-runs on persistent failure', async () => {
    // Forward-slashed for safe embedding in inline bash AND JS string literals
    // (Windows join() yields backslashes; '\a' is an escape in JS strings).
    const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
    const nodes: DagNode[] = [
      {
        id: 'flaky-script',
        script: `require('fs').appendFileSync('${attempts}', 'a'); process.exit(1)`,
        runtime: 'bun',
        retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
      },
    ];
    const { mockDeps } = await runNodes(nodes);

    const content = await readFile(attempts, 'utf8');
    // 1 initial + 2 retries = 3. Without the fix this is 1.
    expect(content.length).toBe(3);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  }, 10_000);

  it('bash retry sends a platform notification before each retry', async () => {
    // Forward-slashed for safe embedding in inline bash AND JS string literals
    // (Windows join() yields backslashes; '\a' is an escape in JS strings).
    const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
    const nodes: DagNode[] = [
      {
        id: 'notify',
        bash: `printf 'a' >> '${attempts}'; echo 'boom' >&2; exit 1`,
        retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
      },
    ];
    const { platform } = await runNodes(nodes);

    const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls;
    const retryMessages = sendCalls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'string' && (call[1] as string).includes('Retrying in')
    );
    // 2 retries → 2 retry notifications.
    expect(retryMessages.length).toBe(2);
  }, 5_000);
});

describe('executeDagWorkflow -- tool_called event persistence', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should persist tool_called event during DAG node execution', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Reading file...' };
      yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/tmp/test.ts' } };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'tool-test-dag',
        nodes: [node('my-cmd')],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const toolCalledEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'tool_called'
    );
    expect(toolCalledEvents.length).toBe(1);
    const eventData = toolCalledEvents[0][0] as Record<string, unknown>;
    expect(eventData.step_name).toBe('my-cmd');
    expect((eventData.data as Record<string, unknown>).tool_name).toBe('read_file');
    expect((eventData.data as Record<string, unknown>).tool_input).toEqual({
      path: '/tmp/test.ts',
    });
  });

  it('calls sendStructuredEvent for tool messages in streaming mode during DAG', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    (platform.getStreamingMode as Mock).mockReturnValue('stream');
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'tool', toolName: 'Write', toolInput: { path: '/bar', content: 'x' } };
      yield { type: 'result', sessionId: 'dag-session-tool' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-tool',
      testDir,
      { name: 'dag-tool-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(platform.sendStructuredEvent).toHaveBeenCalledWith('conv-dag-tool', {
      type: 'tool',
      toolName: 'Write',
      toolInput: { path: '/bar', content: 'x' },
    });
  });
});

describe('executeDagWorkflow -- tool_completed event emission', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-toolcomplete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should emit tool_completed with duration_ms when next tool starts in DAG node', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/a' } };
      yield { type: 'tool', toolName: 'write_file', toolInput: { path: '/b', content: 'x' } };
      yield { type: 'result', sessionId: 'dag-sess-1' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-complete',
      testDir,
      { name: 'dag-complete-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const completedEvents = createEventCalls.filter(([arg]) => arg.event_type === 'tool_completed');

    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
    const readFileComplete = completedEvents.find(([arg]) => arg.data?.tool_name === 'read_file');
    expect(readFileComplete).toBeDefined();
    expect(typeof readFileComplete?.[0].data?.duration_ms).toBe('number');
    expect((readFileComplete?.[0].data?.duration_ms as number) >= 0).toBe(true);
  });

  it('should emit tool_completed for last tool on result in DAG node', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/a' } };
      yield { type: 'result', sessionId: 'dag-sess-2' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-last',
      testDir,
      { name: 'dag-last-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const completedEvents = createEventCalls.filter(([arg]) => arg.event_type === 'tool_completed');

    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0][0].data?.tool_name).toBe('read_file');
    expect(typeof completedEvents[0][0].data?.duration_ms).toBe('number');
  });

  it('should not emit tool_completed when no tools were called in DAG node', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-sess-3' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-notools',
      testDir,
      { name: 'dag-notools-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const completedEvents = createEventCalls.filter(([arg]) => arg.event_type === 'tool_completed');

    expect(completedEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadMcpConfig — per-node MCP server config loading (#445)
// ---------------------------------------------------------------------------

describe('loadMcpConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads and parses a valid MCP config JSON', async () => {
    const config = { github: { command: 'npx', args: ['-y', '@mcp/server-github'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    expect(result.serverNames).toEqual(['github']);
    expect(result.servers).toEqual(config);
    expect(result.missingVars).toEqual([]);
  });

  it('loads standard mcpServers-wrapped config JSON', async () => {
    const servers = { figma: { url: 'http://127.0.0.1:3845/mcp' } };
    await writeFile(join(testDir, 'wrapped.json'), JSON.stringify({ mcpServers: servers }));

    const result = await loadMcpConfig('wrapped.json', testDir);
    expect(result.serverNames).toEqual(['figma']);
    expect(result.servers).toEqual(servers);
  });

  it('rejects mixed mcpServers wrapper and top-level metadata', async () => {
    const servers = { figma: { url: 'http://127.0.0.1:3845/mcp' } };
    await writeFile(
      join(testDir, 'mixed-wrapper.json'),
      JSON.stringify({ $schema: 'https://example.com/schema.json', mcpServers: servers })
    );

    await expect(loadMcpConfig('mixed-wrapper.json', testDir)).rejects.toThrow(
      'cannot mix top-level "mcpServers" with other keys'
    );
  });

  it('loads multiple servers from one config', async () => {
    const config = {
      github: { command: 'npx', args: ['-y', '@mcp/server-github'] },
      postgres: { command: 'npx', args: ['-y', '@mcp/server-postgres'] },
    };
    await writeFile(join(testDir, 'multi.json'), JSON.stringify(config));

    const result = await loadMcpConfig('multi.json', testDir);
    expect(result.serverNames).toEqual(['github', 'postgres']);
  });

  it('expands $VAR_NAME in env values from process.env', async () => {
    process.env.TEST_MCP_TOKEN_445 = 'secret123';
    const config = { github: { command: 'npx', env: { TOKEN: '$TEST_MCP_TOKEN_445' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.github as Record<string, unknown>;
    expect(server.env).toEqual({ TOKEN: 'secret123' });

    delete process.env.TEST_MCP_TOKEN_445;
  });

  it('expands $VAR_NAME in headers values', async () => {
    process.env.TEST_API_KEY_445 = 'key456';
    const config = {
      api: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer $TEST_API_KEY_445' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.api as Record<string, unknown>;
    expect(server.headers).toEqual({ Authorization: 'Bearer key456' });

    delete process.env.TEST_API_KEY_445;
  });

  it('replaces undefined env vars with empty string and reports them', async () => {
    delete process.env.NONEXISTENT_VAR_445;
    const config = { svc: { command: 'npx', env: { KEY: '$NONEXISTENT_VAR_445' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.env).toEqual({ KEY: '' });
    expect(result.missingVars).toContain('NONEXISTENT_VAR_445');
  });

  it('does not expand vars in command or args fields', async () => {
    process.env.TEST_CMD_445 = 'should-not-expand';
    const config = { svc: { command: '$TEST_CMD_445', args: ['$TEST_CMD_445'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.command).toBe('$TEST_CMD_445');
    expect(server.args).toEqual(['$TEST_CMD_445']);

    delete process.env.TEST_CMD_445;
  });

  it('resolves absolute paths as-is', async () => {
    const config = { svc: { command: 'npx' } };
    const absPath = join(testDir, 'abs.json');
    await writeFile(absPath, JSON.stringify(config));

    const result = await loadMcpConfig(absPath, '/some/other/dir');
    expect(result.serverNames).toEqual(['svc']);
  });

  it('throws on missing file', async () => {
    await expect(loadMcpConfig('nonexistent.json', testDir)).rejects.toThrow(
      'MCP config file not found'
    );
  });

  it('throws on invalid JSON', async () => {
    await writeFile(join(testDir, 'bad.json'), 'not json');
    await expect(loadMcpConfig('bad.json', testDir)).rejects.toThrow('not valid JSON');
  });

  it('throws on non-object JSON (array)', async () => {
    await writeFile(join(testDir, 'arr.json'), '[]');
    await expect(loadMcpConfig('arr.json', testDir)).rejects.toThrow('must be a JSON object');
  });

  it('throws on non-object JSON (string)', async () => {
    await writeFile(join(testDir, 'str.json'), '"hello"');
    await expect(loadMcpConfig('str.json', testDir)).rejects.toThrow('must be a JSON object');
  });

  it('throws on array-valued server config', async () => {
    await writeFile(join(testDir, 'server-array.json'), JSON.stringify({ figma: [] }));

    await expect(loadMcpConfig('server-array.json', testDir)).rejects.toThrow(
      'MCP server "figma" must be a JSON object'
    );
  });

  it('throws on non-string env values', async () => {
    await writeFile(
      join(testDir, 'env-number.json'),
      JSON.stringify({ figma: { command: 'figma-mcp', env: { TOKEN: 123 } } })
    );

    await expect(loadMcpConfig('env-number.json', testDir)).rejects.toThrow(
      'MCP config figma.env.TOKEN must be a string'
    );
  });

  it('throws on non-string header values', async () => {
    await writeFile(
      join(testDir, 'header-array.json'),
      JSON.stringify({
        figma: {
          type: 'http',
          url: 'http://127.0.0.1:3845/mcp',
          headers: { Authorization: ['Bearer token'] },
        },
      })
    );

    await expect(loadMcpConfig('header-array.json', testDir)).rejects.toThrow(
      'MCP config figma.headers.Authorization must be a string'
    );
  });

  it('expands ${VAR_NAME} brace-form in env values', async () => {
    process.env.TEST_MCP_TOKEN_1612 = 'braced-secret';
    const config = { github: { command: 'npx', env: { TOKEN: '${TEST_MCP_TOKEN_1612}' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.github as Record<string, unknown>;
    expect(server.env).toEqual({ TOKEN: 'braced-secret' });

    delete process.env.TEST_MCP_TOKEN_1612;
  });

  it('expands ${VAR_NAME} brace-form in headers values', async () => {
    process.env.TEST_API_KEY_1612 = 'braced-key';
    const config = {
      api: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer ${TEST_API_KEY_1612}' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.api as Record<string, unknown>;
    expect(server.headers).toEqual({ Authorization: 'Bearer braced-key' });

    delete process.env.TEST_API_KEY_1612;
  });

  it('replaces undefined brace-form vars with empty string and reports them', async () => {
    delete process.env.NONEXISTENT_VAR_1612;
    const config = { svc: { command: 'npx', env: { KEY: '${NONEXISTENT_VAR_1612}' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.env).toEqual({ KEY: '' });
    expect(result.missingVars).toContain('NONEXISTENT_VAR_1612');
  });

  it('expands mixed bare and brace-form vars in the same string', async () => {
    process.env.TEST_HOST_1612 = 'db.example.com';
    process.env.TEST_PORT_1612 = '5432';
    const config = {
      db: {
        command: 'npx',
        env: { DSN: 'postgres://$TEST_HOST_1612:${TEST_PORT_1612}/mydb' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.db as Record<string, unknown>;
    expect(server.env).toEqual({ DSN: 'postgres://db.example.com:5432/mydb' });

    delete process.env.TEST_HOST_1612;
    delete process.env.TEST_PORT_1612;
  });

  it('does not expand brace-form vars in command or args fields', async () => {
    process.env.TEST_CMD_1612 = 'should-not-expand';
    const config = { svc: { command: '${TEST_CMD_1612}', args: ['${TEST_CMD_1612}'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.command).toBe('${TEST_CMD_1612}');
    expect(server.args).toEqual(['${TEST_CMD_1612}']);

    delete process.env.TEST_CMD_1612;
  });
});

// ---------------------------------------------------------------------------
// Skills — executor-level behavior (#446)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- skills options', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes agents/agent/allowedTools to sendQuery when node has skills', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-skills',
        nodes: [{ id: 'review', command: 'my-cmd', skills: ['codebase-search', 'test-runner'] }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    // skills are passed in nodeConfig — provider translates to agents internally
    expect(nodeConfig?.skills).toEqual(['codebase-search', 'test-runner']);
  });

  it('appends Skill to existing allowed_tools list when node has both', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-skills-tools',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            skills: ['codebase-search'],
            allowed_tools: ['Read', 'Grep'],
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    // skills and allowed_tools are both in nodeConfig — provider merges internally
    expect(nodeConfig?.skills).toEqual(['codebase-search']);
    expect(nodeConfig?.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('does not warn about skills on Codex DAG node — Codex auto-discovers skills from .agents/skills/', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-skills',
        nodes: [
          { id: 'review', command: 'my-cmd', provider: 'codex', skills: ['codebase-search'] },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    // No warning about skills should be sent — Codex supports skills via filesystem auto-discovery
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('skills') && m.includes('codex'));
    expect(warning).toBeUndefined();
  });

  it('passes agents to sendQuery nodeConfig when node has inline agents', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const agentsMap = {
      'brief-gen': {
        description: 'Summarises an issue',
        prompt: 'You are concise.',
        model: 'haiku',
        tools: ['Bash', 'Read'],
      },
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-agents',
        nodes: [{ id: 'review', command: 'my-cmd', agents: agentsMap }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.agents).toEqual(agentsMap);
  });

  it('warns user when Codex DAG node has inline agents', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-agents',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            provider: 'codex',
            agents: {
              'brief-gen': { description: 'd', prompt: 'p' },
            },
          },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('agents') && m.includes('codex'));
    expect(warning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Skills — loader validation via discoverWorkflows (#446)
// ---------------------------------------------------------------------------

describe('skills field validation via parseWorkflow', () => {
  it('parses valid skills array on a DAG node', () => {
    const yaml = `
name: test-skills
description: test
nodes:
  - id: review
    prompt: "Review the code"
    skills:
      - codebase-search
      - test-runner
`;
    const result = parseWorkflow(yaml, 'test.yaml');
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    expect(wf.nodes[0].skills).toEqual(['codebase-search', 'test-runner']);
  });

  it('rejects non-string skills array entries', () => {
    const yaml = `
name: bad-skills
description: test
nodes:
  - id: review
    prompt: "Review"
    skills:
      - 123
`;
    const result = parseWorkflow(yaml, 'bad.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('skills');
  });

  it('rejects empty skills array', () => {
    const yaml = `
name: empty-skills
description: test
nodes:
  - id: review
    prompt: "Review"
    skills: []
`;
    const result = parseWorkflow(yaml, 'empty.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('skills');
  });

  it('ignores skills on bash nodes with warning', () => {
    const yaml = `
name: bash-skills
description: test
nodes:
  - id: lint
    bash: "echo lint"
    skills:
      - should-be-ignored
`;
    const result = parseWorkflow(yaml, 'bash-skills.yaml');
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    // Bash nodes don't get the skills field
    expect(wf.nodes[0].skills).toBeUndefined();
  });

  it('node with no skills has undefined skills field', () => {
    const yaml = `
name: no-skills
description: test
nodes:
  - id: basic
    prompt: "Do something"
`;
    const result = parseWorkflow(yaml, 'no-skills.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    expect(wf.nodes[0].skills).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inline agents — field validation via parseWorkflow
// ---------------------------------------------------------------------------

describe('agents field validation via parseWorkflow', () => {
  it('parses a valid agents map on a DAG node', () => {
    const yaml = `
name: test-agents
description: test
nodes:
  - id: triage
    prompt: "Spawn a brief-gen sub-agent"
    agents:
      brief-gen:
        description: Summarises an issue
        prompt: "You are concise. Return JSON { summary }."
        model: haiku
        tools: [Bash, Read]
`;
    const result = parseWorkflow(yaml, 'agents.yaml');
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    const node = wf.nodes[0];
    expect(node.agents).toBeDefined();
    expect(node.agents!['brief-gen'].description).toBe('Summarises an issue');
    expect(node.agents!['brief-gen'].model).toBe('haiku');
    expect(node.agents!['brief-gen'].tools).toEqual(['Bash', 'Read']);
  });

  it('rejects an agent missing description', () => {
    const yaml = `
name: missing-desc
description: test
nodes:
  - id: triage
    prompt: "p"
    agents:
      brief-gen:
        prompt: "You are concise."
`;
    const result = parseWorkflow(yaml, 'missing-desc.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('agents');
  });

  it('rejects an agent missing prompt', () => {
    const yaml = `
name: missing-prompt
description: test
nodes:
  - id: triage
    prompt: "p"
    agents:
      brief-gen:
        description: "A brief generator"
`;
    const result = parseWorkflow(yaml, 'missing-prompt.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('agents');
  });

  it('rejects empty agents map', () => {
    const yaml = `
name: empty-agents
description: test
nodes:
  - id: triage
    prompt: "p"
    agents: {}
`;
    const result = parseWorkflow(yaml, 'empty-agents.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('agents');
  });

  it('rejects agent ID that is not kebab-case', () => {
    const yaml = `
name: bad-id
description: test
nodes:
  - id: triage
    prompt: "p"
    agents:
      BriefGen:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'bad-id.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('kebab-case');
  });

  it('ignores agents on bash nodes (field stripped, no error)', () => {
    const yaml = `
name: bash-agents
description: test
nodes:
  - id: lint
    bash: "echo lint"
    agents:
      helper:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'bash-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });

  it('ignores agents on script nodes (field stripped, no error)', () => {
    const yaml = `
name: script-agents
description: test
nodes:
  - id: run
    script: 'console.log("hi")'
    runtime: bun
    agents:
      helper:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'script-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });

  it('ignores agents on loop nodes (field stripped, no error)', () => {
    const yaml = `
name: loop-agents
description: test
nodes:
  - id: iterate
    loop:
      prompt: "Do the work"
      until: "DONE"
      max_iterations: 2
    agents:
      helper:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'loop-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });

  it('node with no agents field is undefined', () => {
    const yaml = `
name: no-agents
description: test
nodes:
  - id: basic
    prompt: "Do something"
`;
    const result = parseWorkflow(yaml, 'no-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });
});

describe('executeDagWorkflow -- resume with priorCompletedNodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'step1.md'), 'Step 1 prompt');
    await writeFile(join(commandsDir, 'step2.md'), 'Step 2 prompt using $step1.output');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('skips nodes that appear in priorCompletedNodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map([['step1', 'prior step1 output']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', command: 'step2', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // Only step2 should have been executed (step1 was skipped)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('pre-populates nodeOutputs so downstream nodes can use $nodeId.output', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    let capturedPrompt = '';
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      capturedPrompt = prompt;
      yield { type: 'assistant', content: 'step2 result' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const priorCompletedNodes = new Map([['step1', 'hello from prior run']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', prompt: 'Use this: $step1.output', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // The prompt sent to AI should contain the prior run's output
    expect(capturedPrompt).toContain('hello from prior run');
  });

  it('emits node_skipped_prior_success event for resumed nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-run-id');

    const priorCompletedNodes = new Map([['step1', 'prior output']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', command: 'step2', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(skippedEvent).toBeDefined();
    expect(skippedEvent[0].data.node_output).toBe('prior output');
  });

  it('emits node_skipped_prior_success with empty output when node ID not in map', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-empty-output');

    // priorCompletedNodes has step1 but with undefined value to test the ?? '' fallback
    const priorCompletedNodes = new Map<string, string>([
      ['step1', undefined as unknown as string],
    ]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', command: 'step2', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(skippedEvent).toBeDefined();
    // The ?? '' fallback kicks in when the map value is undefined
    expect(skippedEvent[0].data.node_output).toBe('');
  });

  it('runs all nodes when priorCompletedNodes is empty', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', command: 'step2', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      new Map()
    );

    // Both nodes should execute
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
  });

  // #2091: on resume, prior completed nodes are rehydrated from text only, so the
  // producer's output_format field set must be re-derived from the loaded definition —
  // otherwise the strict `$node.output.field` contract downgrades to the schemaless
  // path and a resumed run gets different semantics than a fresh one.
  it("re-derives declaredFields on resume so a declared-optional-absent field resolves to ''", async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-declared-optional');

    let capturedPrompt = '';
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      capturedPrompt = prompt;
      yield { type: 'assistant', content: 'step2 result' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    // Prior JSON output omits the declared-optional `note` field.
    const priorCompletedNodes = new Map([['step1', '{"type":"BUG"}']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'declared-optional',
        nodes: [
          {
            id: 'step1',
            prompt: 'produce json',
            output_format: {
              type: 'object',
              properties: { type: { type: 'string' }, note: { type: 'string' } },
              required: ['type'],
            },
          },
          { id: 'step2', prompt: 'note=[$step1.output.note]', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // The consumer must run (step1 was skipped, so exactly one AI call = step2),
    // and the declared-but-absent `note` resolves to '' — not a missing-key throw.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(capturedPrompt).toBe('note=[]');
  });

  it('re-derives declaredFields on resume so an undeclared key fails the consumer (not-in-schema)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-undeclared-key');

    // Prior JSON output carries an `extra` key that the schema does NOT declare.
    const priorCompletedNodes = new Map([['step1', '{"type":"BUG","extra":"x"}']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'undeclared-key',
        nodes: [
          {
            id: 'step1',
            prompt: 'produce json',
            output_format: {
              type: 'object',
              properties: { type: { type: 'string' } },
              required: ['type'],
            },
          },
          { id: 'step2', prompt: 'extra=[$step1.output.extra]', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // The undeclared `extra` must fail the consumer before the AI runs (0 calls),
    // matching fresh-run behavior instead of silently resolving via the schemaless path.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'step2'
    );
    expect(failedEvent).toBeDefined();
    expect((failedEvent[0].data as { error: string }).error).toContain('is not declared in node');
  });

  it('stores node_output in node_completed event data for bash nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-output-persist-run');

    const bashNode: BashNode = { id: 'stats', bash: 'echo "bash output"' };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash-output',
      testDir,
      { name: 'bash-output-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'stats'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toContain(
      'bash output'
    );
  });

  it('stores node_output in node_completed event data for AI nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('output-persist-run');

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'the node output text' };
      yield { type: 'result', sessionId: 'sid' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-output',
      testDir,
      { name: 'single-node', nodes: [{ id: 'step1', command: 'step1' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toBe(
      'the node output text'
    );
  });

  // ─── Background Agent Task Gating (#2083) ───────────────────────────────

  describe('background task completion gating (#2083)', () => {
    const runSingleNode = async (
      store: ReturnType<typeof createMockStore>,
      platform: IWorkflowPlatform,
      runId: string
    ): Promise<void> => {
      const mockDeps = createMockDeps(store);
      const workflowRun = makeWorkflowRun(runId);
      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-bg-tasks',
        testDir,
        { name: 'bg-task-test', nodes: [{ id: 'step1', command: 'step1' }] },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );
    };

    const findCompletedEvent = (
      store: ReturnType<typeof createMockStore>
    ): { data: Record<string, unknown> } | undefined => {
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const call = eventCalls.find(
        (c: unknown[]) =>
          (c[0] as { event_type: string }).event_type === 'node_completed' &&
          (c[0] as { step_name: string }).step_name === 'step1'
      );
      return call?.[0] as { data: Record<string, unknown> } | undefined;
    };

    it('waits past a result with live background tasks and captures the follow-up output', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'background_tasks',
          tasks: [{ taskId: 't-1', taskType: 'local_agent', description: 'bg research' }],
        };
        yield { type: 'assistant', content: 'spawned agents' };
        // Turn-level result while t-1 is still live — must NOT complete the node
        yield { type: 'result', sessionId: 'sid', cost: 0.1 };
        // Post-result: task drains, follow-up turn integrates its output
        yield { type: 'assistant', content: ' + integrated task output' };
        yield { type: 'background_tasks', tasks: [] };
        yield { type: 'result', sessionId: 'sid', cost: 0.3 };
      });

      const store = createMockStore();
      const platform = createMockPlatform();
      await runSingleNode(store, platform, 'bg-wait-run');

      const completed = findCompletedEvent(store);
      expect(completed).toBeDefined();
      // Output includes the post-result follow-up turn (the wait actually happened)
      expect(completed!.data.node_output).toBe('spawned agents + integrated task output');
      // Cost is the LAST result's session-cumulative value, not a sum
      expect(completed!.data.cost_usd).toBe(0.3);
      // Clean drain → no incompleteness recorded
      expect(completed!.data.background_tasks_incomplete).toBeUndefined();
      // The wait was announced to the user once
      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
        String(c[1])
      );
      expect(sent.some(m => m.includes('background agent task(s) still running'))).toBe(true);
    });

    it('records background_tasks_incomplete and warns when the stream ends with live tasks', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'background_tasks',
          tasks: [{ taskId: 't-orphan', taskType: 'local_agent', description: 'never drains' }],
        };
        yield { type: 'assistant', content: 'partial work' };
        yield { type: 'result', sessionId: 'sid' };
        // Generator ends without the set draining (subprocess death analog)
      });

      const store = createMockStore();
      const platform = createMockPlatform();
      await runSingleNode(store, platform, 'bg-incomplete-run');

      const completed = findCompletedEvent(store);
      expect(completed).toBeDefined();
      expect(completed!.data.background_tasks_incomplete).toEqual(['t-orphan']);
      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
        String(c[1])
      );
      expect(sent.some(m => m.includes('output may be missing'))).toBe(true);
    });

    it('suppresses the incompleteness warning when the node is genuinely cancelled with live tasks', async () => {
      // The run is cancelled mid-stream (caught by the throttled status check)
      // while a background task is still live. The stream ends with the task
      // dangling, but the node already returns 'failed — Cancelled by user',
      // so the incompleteness warning must be suppressed as noise.
      // setSystemTime jumps past CANCEL_CHECK_INTERVAL_MS between chunks so the
      // second status check fires deterministically (no real waiting).
      let tasksDelivered = false;
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'background_tasks',
          tasks: [{ taskId: 't-live', taskType: 'local_agent', description: 'still running' }],
        };
        tasksDelivered = true;
        setSystemTime(new Date(Date.now() + 11_000));
        yield { type: 'assistant', content: 'partial work' };
        yield { type: 'assistant', content: 'MUST NOT BE REACHED' };
      });

      const store = createMockStore();
      // 'running' until the task set has been delivered, 'cancelled' after —
      // guarantees the abort happens with the task registered as live.
      (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() =>
        Promise.resolve(tasksDelivered ? 'cancelled' : 'running')
      );
      const platform = createMockPlatform();
      try {
        await runSingleNode(store, platform, 'bg-cancelled-run');
      } finally {
        setSystemTime(); // restore the real clock
      }

      // The node failed as cancelled — it never completed
      expect(findCompletedEvent(store)).toBeUndefined();
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const failedEvent = eventCalls.find(
        (c: unknown[]) =>
          (c[0] as { event_type: string }).event_type === 'node_failed' &&
          (c[0] as { step_name: string }).step_name === 'step1'
      );
      expect(failedEvent).toBeDefined();
      expect((failedEvent![0] as { data: { error: string } }).data.error).toBe('Cancelled by user');
      // Cancellation exemption: no user-facing incompleteness warning
      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
        String(c[1])
      );
      expect(sent.some(m => m.includes('output may be missing'))).toBe(false);
      expect(sent.some(m => m.includes('background agent'))).toBe(false);
    });

    it('breaks at the first result when no background_tasks chunk was seen (unchanged behavior)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'normal output' };
        yield { type: 'result', sessionId: 'sid' };
        // Anything after the result must NOT be consumed
        yield { type: 'assistant', content: ' MUST NOT APPEAR' };
      });

      const store = createMockStore();
      const platform = createMockPlatform();
      await runSingleNode(store, platform, 'bg-none-run');

      const completed = findCompletedEvent(store);
      expect(completed).toBeDefined();
      expect(completed!.data.node_output).toBe('normal output');
      expect(completed!.data.background_tasks_incomplete).toBeUndefined();
    });

    it('persists output_file on task_notification task_activity events', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'delegating' };
        yield {
          type: 'task_notification',
          taskId: 't-9',
          status: 'completed',
          summary: 'wrote the report',
          outputFile: '/tmp/task-9-output.md',
        };
        yield { type: 'result', sessionId: 'sid' };
      });

      const store = createMockStore();
      const platform = createMockPlatform();
      await runSingleNode(store, platform, 'bg-output-file-run');

      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const taskEvent = eventCalls.find(
        (c: unknown[]) =>
          (c[0] as { event_type: string }).event_type === 'task_activity' &&
          (c[0] as { data: { task_id?: string } }).data.task_id === 't-9'
      );
      expect(taskEvent).toBeDefined();
      expect((taskEvent![0] as { data: { output_file?: string } }).data.output_file).toBe(
        '/tmp/task-9-output.md'
      );
    });
  });

  // ─── Loop Node Tests ─────────────────────────────────────────────────────

  describe('loop node execution', () => {
    it('completes on <promise>COMPLETE</promise> signal in first iteration', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Did the task. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-test',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery exactly once (completed on iteration 1)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Workflow should be marked completed with node counts metadata
      const completeCalls = (
        mockDeps.store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0][1]).toEqual({
        node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      });
    });

    it('does not double-count cost when an iteration sees two results (background-task wait, #2083)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'background_tasks',
          tasks: [{ taskId: 't-1', taskType: 'local_agent', description: 'bg work' }],
        };
        yield { type: 'assistant', content: 'Done. <promise>COMPLETE</promise>' };
        // Session-cumulative cost: 0.1 at the first result, 0.3 at the final one
        yield { type: 'result', sessionId: 'loop-sid', cost: 0.1 };
        yield { type: 'background_tasks', tasks: [] };
        yield { type: 'result', sessionId: 'loop-sid', cost: 0.3 };
      });

      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('loop-bg-cost-run');

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-bg-cost',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const completedEvent = eventCalls.find(
        (c: unknown[]) =>
          (c[0] as { event_type: string }).event_type === 'node_completed' &&
          (c[0] as { step_name: string }).step_name === 'my-loop'
      );
      expect(completedEvent).toBeDefined();
      // 0.3 (last session-cumulative value), NOT 0.4 (0.1 + 0.3 double-count)
      expect((completedEvent![0] as { data: { cost_usd?: number } }).data.cost_usd).toBe(0.3);
    });

    it('records the cross-iteration union of dangling background tasks on node_completed (#2083)', async () => {
      // Iterations 1 and 2 each end with a different task still live (subprocess
      // death analog); iteration 3 finishes cleanly and signals completion. The
      // node_completed event must carry the UNION of dangling ids — last-iteration
      // reporting would hide t-a and t-b behind the clean final iteration.
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'background_tasks',
            tasks: [{ taskId: 't-a', taskType: 'local_agent', description: 'never drains' }],
          };
          yield { type: 'assistant', content: 'first pass' };
          yield { type: 'result', sessionId: 'sid-1' };
          // Generator ends with t-a live
        } else if (callCount === 2) {
          yield {
            type: 'background_tasks',
            tasks: [{ taskId: 't-b', taskType: 'local_agent', description: 'never drains' }],
          };
          yield { type: 'assistant', content: 'second pass' };
          yield { type: 'result', sessionId: 'sid-2' };
          // Generator ends with t-b live
        } else {
          yield { type: 'assistant', content: 'All done! <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'sid-3' };
        }
      });

      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('loop-bg-union-run');

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-bg-union',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(3);
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const completedEvent = eventCalls.find(
        (c: unknown[]) =>
          (c[0] as { event_type: string }).event_type === 'node_completed' &&
          (c[0] as { step_name: string }).step_name === 'my-loop'
      );
      expect(completedEvent).toBeDefined();
      const data = (completedEvent![0] as { data: Record<string, unknown> }).data;
      expect(data.background_tasks_incomplete).toEqual(['t-a', 't-b']);
      // Each incomplete iteration also warned the user
      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
        String(c[1])
      );
      expect(sent.filter(m => m.includes('output may be missing')).length).toBe(2);
    });

    it('omits background_tasks_incomplete from node_completed when every iteration drains cleanly', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'background_tasks',
          tasks: [{ taskId: 't-1', taskType: 'local_agent', description: 'bg work' }],
        };
        yield { type: 'assistant', content: 'Done. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'sid-clean' };
        yield { type: 'background_tasks', tasks: [] };
        yield { type: 'result', sessionId: 'sid-clean' };
      });

      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('loop-bg-clean-run');

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-bg-clean',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const completedEvent = eventCalls.find(
        (c: unknown[]) =>
          (c[0] as { event_type: string }).event_type === 'node_completed' &&
          (c[0] as { step_name: string }).step_name === 'my-loop'
      );
      expect(completedEvent).toBeDefined();
      expect(
        (completedEvent![0] as { data: Record<string, unknown> }).data.background_tasks_incomplete
      ).toBeUndefined();
    });

    it('cancellation mid-stream aborts the iteration and suppresses the incompleteness warning', async () => {
      // Mirrors the AI-node cancellation-exemption test: the run is cancelled
      // while an iteration is streaming with a live background task. The new
      // mid-stream status check must abort the iteration (previously the loop
      // only noticed cancellation BETWEEN iterations), fail the node with the
      // observed status, and suppress the incompleteness warning.
      let tasksDelivered = false;
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'background_tasks',
          tasks: [{ taskId: 't-loop', taskType: 'local_agent', description: 'still running' }],
        };
        tasksDelivered = true;
        setSystemTime(new Date(Date.now() + 11_000));
        yield { type: 'assistant', content: 'working' };
        yield { type: 'assistant', content: 'MUST NOT BE REACHED' };
      });

      const store = createMockStore();
      // 'running' for the between-iteration check, 'cancelled' once the task
      // set has been delivered mid-stream.
      (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() =>
        Promise.resolve(tasksDelivered ? 'cancelled' : 'running')
      );
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('loop-bg-cancel-run');

      try {
        await executeDagWorkflow(
          mockDeps,
          platform,
          'conv-dag',
          testDir,
          {
            name: 'dag-loop-bg-cancel',
            nodes: [
              {
                id: 'my-loop',
                loop: {
                  prompt: 'Do tasks.',
                  until: 'COMPLETE',
                  max_iterations: 5,
                },
              },
            ],
          },
          workflowRun,
          'claude',
          undefined,
          join(testDir, 'artifacts'),
          join(testDir, 'logs'),
          'main',
          'docs/',
          minimalConfig
        );
      } finally {
        setSystemTime(); // restore the real clock
      }

      // Aborted during iteration 1 — no second iteration
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // The loop never completed
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const completedEvent = eventCalls.find(
        (c: unknown[]) =>
          (c[0] as { event_type: string }).event_type === 'node_completed' &&
          (c[0] as { step_name: string }).step_name === 'my-loop'
      );
      expect(completedEvent).toBeUndefined();
      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
        String(c[1])
      );
      // The stop is surfaced with the observed status…
      expect(sent.some(m => m.includes('stopped during iteration 1 (cancelled)'))).toBe(true);
      // …and the incompleteness warning is suppressed as noise
      expect(sent.some(m => m.includes('output may be missing'))).toBe(false);
    });

    it('completes after multiple iterations', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount < 3) {
          yield { type: 'assistant', content: `Iteration ${String(callCount)} progress` };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        } else {
          yield { type: 'assistant', content: 'All done! <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-multi',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do next task.',
                until: 'COMPLETE',
                max_iterations: 10,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(3);
    });

    it('substitutes $LOOP_PREV_OUTPUT with previous iteration output (empty on iter 1)', async () => {
      // Iteration 1 emits a distinctive output, iteration 2 emits the completion signal.
      // We then assert the prompt sent to the AI: iteration 1 strips $LOOP_PREV_OUTPUT
      // to empty, iteration 2 receives iteration 1's cleaned output.
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'assistant', content: 'Iter1 output: 2 type errors in users.ts' };
          yield { type: 'result', sessionId: 'loop-session-1' };
        } else {
          yield { type: 'assistant', content: 'All fixed. <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'loop-session-2' };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-prev-output',
          nodes: [
            {
              id: 'fix-loop',
              loop: {
                prompt: 'Previous output: <<$LOOP_PREV_OUTPUT>>. Fix and emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      const promptIter1 = mockSendQueryDag.mock.calls[0][0] as string;
      const promptIter2 = mockSendQueryDag.mock.calls[1][0] as string;
      // Iteration 1: $LOOP_PREV_OUTPUT substitutes to empty string.
      expect(promptIter1).toContain('Previous output: <<>>.');
      // Iteration 2: receives iteration 1's cleaned output.
      expect(promptIter2).toContain(
        'Previous output: <<Iter1 output: 2 type errors in users.ts>>.'
      );
    });

    it('strips <promise> tags from $LOOP_PREV_OUTPUT (uses cleaned output)', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount === 1) {
          // Iteration 1 includes a non-completion XML tag in its output. The cleaned
          // output (after stripCompletionTags) drops <promise>...</promise> blocks.
          // We use a non-matching signal here so iteration 1 does NOT complete.
          yield {
            type: 'assistant',
            content: 'Real work output. <promise>NOT_DONE_YET</promise>',
          };
          yield { type: 'result', sessionId: 'loop-session-1' };
        } else {
          yield { type: 'assistant', content: 'Done. <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'loop-session-2' };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-prev-clean',
          nodes: [
            {
              id: 'fix-loop',
              loop: {
                prompt: 'PREV=[$LOOP_PREV_OUTPUT]',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      const promptIter2 = mockSendQueryDag.mock.calls[1][0] as string;
      // The previous-output payload must be the *cleaned* output — no <promise> tags.
      expect(promptIter2).toContain('PREV=[Real work output.');
      expect(promptIter2).not.toContain('<promise>');
    });

    it('$LOOP_PREV_OUTPUT is empty on the first iteration after interactive resume', async () => {
      // Regression guard for the resume-from-approval path: when an interactive
      // loop pauses at the approval gate, the prior `lastIterationOutput` lives
      // in a separate process and is not persisted. On resume, the executor must
      // substitute $LOOP_PREV_OUTPUT to '' on the first resumed iteration —
      // never to whatever the paused run produced.
      //
      // Wirasm-suggested shape (PR #1367 review): two executeDagWorkflow calls.
      // The first call pauses at the gate after iteration 1; the second call
      // resumes with metadata.approval populated and runs iteration 2.

      // ---- Call 1: fresh run, iteration 1 emits no completion → pauses at gate
      mockSendQueryDag.mockImplementationOnce(function* () {
        yield { type: 'assistant', content: 'Iter1 output: 2 type errors in users.ts' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      });
      const mockDeps1 = createMockDeps();
      const platform1 = createMockPlatform();
      const freshRun = makeWorkflowRun('resume-prev-fresh-run');

      await executeDagWorkflow(
        mockDeps1,
        platform1,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume-prev-output',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt:
                  'User: $LOOP_USER_INPUT. PREV=<<$LOOP_PREV_OUTPUT>>. Continue or emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        freshRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // First iteration of a fresh interactive loop: $LOOP_PREV_OUTPUT empty;
      // $LOOP_USER_INPUT empty (no user has spoken yet).
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const promptIter1 = mockSendQueryDag.mock.calls[0][0] as string;
      expect(promptIter1).toContain('PREV=<<>>.');
      expect(promptIter1).toContain('User: .');
      // Fresh interactive loop must pause at the gate, not return early.
      const pauseCalls1 = (
        mockDeps1.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls1.length).toBe(1);
      expect(pauseCalls1[0][1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 1,
      });

      // ---- Call 2: resumed run — metadata carries iter 1 + user input.
      // iter 2 emits the completion signal so the loop exits cleanly.
      mockSendQueryDag.mockImplementationOnce(function* () {
        yield { type: 'assistant', content: 'All clear. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-session-2' };
      });
      const mockDeps2 = createMockDeps();
      const platform2 = createMockPlatform();
      const resumedRun = makeWorkflowRun('resume-prev-resume-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'loop-session-1',
            message: 'Review and provide feedback.',
          },
          loop_user_input: 'looks good, ship it',
        },
      });

      await executeDagWorkflow(
        mockDeps2,
        platform2,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume-prev-output',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt:
                  'User: $LOOP_USER_INPUT. PREV=<<$LOOP_PREV_OUTPUT>>. Continue or emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        resumedRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Second executeDagWorkflow call started a fresh sendQuery generator (mock
      // call index 1 across the two runs). The resumed iteration must NOT carry
      // the prior process's iter-1 output through $LOOP_PREV_OUTPUT — it must
      // substitute to ''.
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      const promptResumeIter = mockSendQueryDag.mock.calls[1][0] as string;
      expect(promptResumeIter).toContain('PREV=<<>>.');
      expect(promptResumeIter).not.toContain('Iter1 output: 2 type errors');
      // The resume's user input flows through on the first resumed iteration.
      expect(promptResumeIter).toContain('User: looks good, ship it.');
      // Resume call exits via completion, not via a second pause at the gate.
      const pauseCalls2 = (
        mockDeps2.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls2.length).toBe(0);
    });

    it('fails when max_iterations exceeded', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: 'loop-session' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-max',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery exactly 2 times (max_iterations)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // Workflow should be marked failed (no completion signal)
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(1);
    });

    it('completes on final iteration with XML-wrapped signal (<COMPLETE>SIGNAL</COMPLETE>)', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount < 3) {
          yield { type: 'assistant', content: `Iteration ${String(callCount)} progress` };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        } else {
          // Final iteration uses <COMPLETE> tag instead of <promise>
          yield { type: 'assistant', content: 'All clean! <COMPLETE>ALL_CLEAN</COMPLETE>' };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-xml-tag',
          nodes: [
            {
              id: 'fix-and-review',
              loop: {
                prompt: 'Fix and review. When done, output <COMPLETE>ALL_CLEAN</COMPLETE>.',
                until: 'ALL_CLEAN',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // 3 iterations run, signal found on iteration 3 → completed, NOT failed
      expect(mockSendQueryDag.mock.calls.length).toBe(3);
      expect(
        (
          mockDeps.store.completeWorkflowRun as Mock<
            (id: string, metadata?: Record<string, unknown>) => Promise<void>
          >
        ).mock.calls.length
      ).toBe(1);
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(0);
      // Verify stripping: raw XML completion tags must not appear in user-visible output
      const allSentMessages = (
        platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>
      ).mock.calls
        .map((call: unknown[]) => call[1] as string)
        .join('');
      expect(allSentMessages).not.toContain('<COMPLETE>');
      expect(allSentMessages).not.toContain('</COMPLETE>');
    });

    it('loop node output available to downstream nodes via $nodeId.output', async () => {
      let loopCallCount = 0;
      mockSendQueryDag.mockImplementation(function* (prompt: string) {
        if (prompt.includes('Do task')) {
          loopCallCount++;
          if (loopCallCount >= 2) {
            yield {
              type: 'assistant',
              content: 'Loop result: all tasks done <promise>COMPLETE</promise>',
            };
          } else {
            yield { type: 'assistant', content: 'Working on task 1' };
          }
          yield { type: 'result', sessionId: 'loop-sid' };
        } else {
          // downstream node
          yield { type: 'assistant', content: 'Got upstream: ' + prompt.slice(0, 50) };
          yield { type: 'result', sessionId: 'downstream-sid' };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-output',
          nodes: [
            {
              id: 'impl',
              loop: {
                prompt: 'Do task. Output <promise>COMPLETE</promise> when done.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
            {
              id: 'report',
              prompt: 'Summarize: $impl.output',
              depends_on: ['impl'],
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Loop ran 2 iterations + downstream ran once = 3 calls
      expect(mockSendQueryDag.mock.calls.length).toBe(3);
    });

    it('fresh_context: true gives each iteration fresh session', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount >= 2) {
          yield { type: 'assistant', content: '<promise>DONE</promise>' };
        } else {
          yield { type: 'assistant', content: 'Progress' };
        }
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-fresh',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do stuff.',
                until: 'DONE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Both calls should have undefined resumeSessionId (fresh context)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // First call: fresh (iteration 1 always fresh)
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
      // Second call: also fresh (fresh_context: true)
      expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
    });

    it('fresh_context: false threads session between iterations', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount >= 2) {
          yield { type: 'assistant', content: '<promise>DONE</promise>' };
        } else {
          yield { type: 'assistant', content: 'Progress' };
        }
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-stateful',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do stuff.',
                until: 'DONE',
                max_iterations: 5,
                fresh_context: false,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // First call: fresh (iteration 1 always fresh)
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
      // Second call: should have session-1 from first iteration
      expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
    });

    it('strips <promise> tags from platform output', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Done! <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-sid' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-strip',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Task.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // In batch mode, accumulated clean output is sent
      const sendCalls = (platform.sendMessage as Mock<() => Promise<void>>).mock.calls;
      const contentMessages = sendCalls
        .map((call: unknown[]) => call[1] as string)
        .filter((msg: string) => msg.includes('Done'));
      // Should have stripped <promise> tags
      for (const msg of contentMessages) {
        expect(msg).not.toContain('<promise>');
      }
    });

    it('cancellation between iterations stops the loop', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        yield { type: 'assistant', content: `Iteration ${String(callCount)}` };
        yield { type: 'result', sessionId: `sid-${String(callCount)}` };
      });

      const store = createMockStore();
      let statusCallCount = 0;
      (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() => {
        statusCallCount++;
        // Return 'cancelled' on second status check (before iteration 2)
        if (statusCallCount >= 2) return Promise.resolve('cancelled');
        return Promise.resolve('running');
      });
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-cancel',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do tasks.',
                until: 'COMPLETE',
                max_iterations: 10,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have only done 1 iteration (cancelled before iteration 2)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
    });

    it('AI error mid-iteration returns failed NodeOutput', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        throw new Error('Claude Code auth error: unauthorized');
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-ai-error',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have run exactly 1 iteration (failed on first)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Workflow should be marked failed
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(1);
    });

    it('detects plain completion signal (non-<promise> format)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'All tasks done!\nCOMPLETE' };
        yield { type: 'result', sessionId: 'plain-sid' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-plain-signal',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should complete on first iteration (plain signal on own line)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const completeCalls = (
        mockDeps.store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0][1]).toEqual({
        node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      });
    });

    it('does NOT detect false positive plain signal in middle of text', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'The task is not COMPLETE yet, more work needed.' };
        yield { type: 'result', sessionId: 'false-pos-sid' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-false-positive',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Work.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have run max_iterations times (NOT detected as complete)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // Should have FAILED (not completed)
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(1);
    });

    // ─── Interactive Loop Tests ────────────────────────────────────────────

    it('interactive loop with gate_message pauses after first iteration', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Here is the plan. Please review.' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-test',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine the plan.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review the plan and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery exactly once (paused after iteration 1)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Should have called pauseWorkflowRun with interactive_loop type
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(1);
      expect(pauseCalls[0][1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 1,
        // No signal this iteration — the engine-generated status line says so (#2074)
        // and the author's gate text is preserved at the end.
        completionSignaled: false,
        signaledOutput: null,
      });
      const pausedMessage = (pauseCalls[0][1] as { message: string }).message;
      expect(pausedMessage).toContain('No completion signal');
      expect(pausedMessage).toContain('Review the plan and provide feedback.');
    });

    it('interactive loop first iteration always gates even if AI emits signal', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'assistant',
          content: 'Plan approved. Proceeding. <promise>APPROVED</promise>',
        };
        yield { type: 'result', sessionId: 'loop-session-2' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-signal',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // On first iteration (fresh start, no user input), the loop MUST pause
      // at the gate even if the AI emits the completion signal. The user hasn't
      // seen anything yet — they must review before the loop can exit.
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(1);
      expect(pauseCalls[0][1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 1,
        // The gate persists the signal state (#2074) so a bare approve can
        // finalize at resume instead of re-running the iteration.
        completionSignaled: true,
      });
      const signaledOutput = (pauseCalls[0][1] as { signaledOutput: string }).signaledOutput;
      expect(signaledOutput).toContain('Plan approved');
      const gateMessage = (pauseCalls[0][1] as { message: string }).message;
      expect(gateMessage).toContain('Completion signal detected');
      expect(gateMessage).toContain('Review and provide feedback.');
    });

    it('interactive loop exits on resume when AI emits completion signal (user approved)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'assistant',
          content: 'Plan approved. Proceeding. <promise>APPROVED</promise>',
        };
        yield { type: 'result', sessionId: 'loop-session-3' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      // Simulate a resumed run where the user said "approved"
      const workflowRun = makeWorkflowRun('resume-signal-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'loop-session-2',
            message: 'Review and provide feedback.',
          },
          loop_user_input: 'approved',
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume-signal',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // On resume with user input, the AI processes the approval and emits the
      // completion signal. The loop exits immediately without pausing at the gate.
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(0);
    });

    it('interactive loop resumes from stored iteration with user input', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        yield { type: 'assistant', content: 'Updated plan. <promise>APPROVED</promise>' };
        yield { type: 'result', sessionId: `resumed-session-${String(callCount)}` };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      // Simulate a resumed run: metadata has loop gate state and user input
      const workflowRun = makeWorkflowRun('resumed-run-id', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'loop-session-1',
            message: 'Review the plan.',
          },
          loop_user_input: 'Add error handling',
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine the plan.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review the plan.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery once (starting from iteration 2, completed immediately)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Verify the prompt contains the user input
      const promptArg = mockSendQueryDag.mock.calls[0][0] as string;
      expect(promptArg).toContain('Add error handling');
      // Should have resumed with stored session ID
      const sessionArg = mockSendQueryDag.mock.calls[0][2] as string | undefined;
      expect(sessionArg).toBe('loop-session-1');
    });

    it('signal_completes: true completes the loop on a first-iteration signal without gating (#2074 B)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Validation PASS. <promise>VALIDATED</promise>' };
        yield { type: 'result', sessionId: 'sc-session-1' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('signal-completes-run');

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'signal-completes-test',
          nodes: [
            {
              id: 'validate',
              loop: {
                prompt: 'Validate. Emit VALIDATED on pass.',
                until: 'VALIDATED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review the validation result.',
                signal_completes: true,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // No gate: the node completed autonomously on the signal.
      const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<() => Promise<void>>).mock.calls;
      expect(pauseCalls.length).toBe(0);
      const eventCalls = (
        mockDeps.store.createWorkflowEvent as Mock<
          (e: {
            event_type: string;
            step_name: string;
            data: Record<string, unknown>;
          }) => Promise<void>
        >
      ).mock.calls;
      const completed = eventCalls.filter(
        c => c[0].event_type === 'node_completed' && c[0].step_name === 'validate'
      );
      expect(completed.length).toBe(1);
      expect(String(completed[0][0].data.node_output)).toContain('Validation PASS');
    });

    it('finalizes at resume from persisted signaledOutput on a bare approve — no re-run (#2074 C)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'should never run' };
        yield { type: 'result', sessionId: 'never' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('finalize-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'sig-session-1',
            message: 'gate',
            completionSignaled: true,
            signaledOutput: 'REPORT',
          },
          loop_user_input: 'Approved',
          loop_feedback_given: false,
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'finalize-on-approve',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // No new iteration ran — the node finalized from the persisted output.
      expect(mockSendQueryDag.mock.calls.length).toBe(0);
      const eventCalls = (
        mockDeps.store.createWorkflowEvent as Mock<
          (e: {
            event_type: string;
            step_name: string;
            data: Record<string, unknown>;
          }) => Promise<void>
        >
      ).mock.calls;
      const completed = eventCalls.filter(
        c => c[0].event_type === 'node_completed' && c[0].step_name === 'refine'
      );
      expect(completed.length).toBe(1);
      expect(completed[0][0].data.node_output).toBe('REPORT');
    });

    it('iterates at resume when feedback was given, even on a signal-bearing gate (#2074 C)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Re-checked X. <promise>APPROVED</promise>' };
        yield { type: 'result', sessionId: 'iter-session-2' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('feedback-iterates-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'sig-session-1',
            message: 'gate',
            completionSignaled: true,
            signaledOutput: 'REPORT',
          },
          loop_user_input: 'actually re-check X',
          loop_feedback_given: true,
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'feedback-iterates',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Feedback ⇒ a fresh iteration ran with $LOOP_USER_INPUT substituted.
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const promptArg = mockSendQueryDag.mock.calls[0][0] as string;
      expect(promptArg).toContain('actually re-check X');
    });

    it('iterates at resume on a non-signaled gate even without feedback (#2074 C)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Another pass. <promise>APPROVED</promise>' };
        yield { type: 'result', sessionId: 'iter-session-3' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('nonsignaled-iterates-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'sig-session-1',
            message: 'gate',
            completionSignaled: false,
            signaledOutput: null,
          },
          loop_user_input: 'Approved',
          loop_feedback_given: false,
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'nonsignaled-iterates',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Nothing to finalize — a normal resumed iteration ran.
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
    });

    it('LEGACY: resume with pre-#2074 approval metadata (no completionSignaled/signaledOutput keys) iterates', async () => {
      // Rows paused before #2074 have neither key in metadata.approval and no
      // loop_feedback_given — the finalize path must NOT trigger; the loop runs
      // a normal resumed iteration exactly as before.
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Legacy pass. <promise>APPROVED</promise>' };
        yield { type: 'result', sessionId: 'legacy-session-2' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('legacy-resume-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'legacy-session-1',
            message: 'Review and provide feedback.',
          },
          loop_user_input: 'approved',
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'legacy-loop-resume',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // A real iteration ran (no zero-duration finalize short-circuit).
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const promptArg = mockSendQueryDag.mock.calls[0][0] as string;
      expect(promptArg).toContain('approved');
    });

    it('loop iteration fails loudly when SDK returns error_during_execution', async () => {
      // Regression test for #1208: previously the loop silently broke on isError
      // results and kept iterating with empty output, producing "5-second crashes"
      // that masqueraded as successful iterations.
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_during_execution',
          errors: ['Subprocess crashed mid-turn'],
          sessionId: 'bad-session',
        };
      });

      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'loop-iteration-err',
          nodes: [
            {
              id: 'work',
              loop: {
                prompt: 'Do the work. Say DONE.',
                until: 'DONE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should fail after one iteration rather than burning through max_iterations
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // The loop_iteration_failed event should carry the subtype and SDK errors detail
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const iterFailedEvents = eventCalls.filter(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).event_type === 'loop_iteration_failed'
      );
      expect(iterFailedEvents.length).toBeGreaterThan(0);
      const failedData = (iterFailedEvents[0][0] as Record<string, unknown>).data as Record<
        string,
        unknown
      >;
      expect(failedData.error).toContain('error_during_execution');
      expect(failedData.error).toContain('Subprocess crashed mid-turn');
    });

    it('loop iteration does NOT fail on isError: true + errorSubtype: success', async () => {
      // Regression test for #1425 (loop-branch counterpart of the main-path
      // test). Stop_sequence terminations carry is_error: true + subtype:
      // 'success' under the Claude SDK contract; previously, the loop branch
      // threw "SDK returned success" and aborted the iteration even though
      // the AI had completed its work correctly.
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Done. DONE.' };
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'success',
          stopReason: 'stop_sequence',
          sessionId: 'sid-loop-stop',
        };
      });

      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'loop-success-stop-seq-test',
          nodes: [
            {
              id: 'work',
              loop: {
                prompt: 'Do the work. Say DONE.',
                until: 'DONE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const failedEvents = eventCalls.filter((call: unknown[]) => {
        const evt = (call[0] as Record<string, unknown>).event_type as string;
        return evt === 'node_failed' || evt === 'loop_iteration_failed';
      });
      expect(failedEvents).toHaveLength(0);
    });

    it('non-interactive loop is unaffected (no pause)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: 'loop-session' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'non-interactive-loop',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // pauseWorkflowRun should never be called for non-interactive loops
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(0);
    });
  });
});

describe('executeDagWorkflow -- always_run resume opt-out', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-always-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'producer.md'), 'Producer prompt');
    await writeFile(join(commandsDir, 'consumer.md'), 'Consumer prompt $producer.output');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'fresh output' };
      yield { type: 'result', sessionId: 'session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('re-runs node flagged always_run even when present in priorCompletedNodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map([['producer', 'cached stale output']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-always-run',
      testDir,
      {
        name: 'always-run-producer',
        nodes: [
          { id: 'producer', command: 'producer', always_run: true },
          { id: 'consumer', command: 'consumer', depends_on: ['producer'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // Producer re-runs (instead of being skipped) AND consumer runs => 2 sendQuery calls
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // No skip event written for the always_run node — but a reset event IS written for audit
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(skippedEvent).toBeUndefined();

    const resetEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_always_run_reset' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(resetEvent).toBeDefined();
    expect((resetEvent![0] as { data: { prior_output: string } }).data.prior_output).toBe(
      'cached stale output'
    );
  });

  it('still skips non-always_run nodes in the same priorCompletedNodes set', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'cached.md'), 'Cached prompt');
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map([
      ['producer', 'cached stale output'],
      ['cached', 'cached output'],
    ]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-mixed',
      testDir,
      {
        name: 'mixed',
        nodes: [
          { id: 'producer', command: 'producer', always_run: true },
          { id: 'cached', command: 'cached' },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // Only producer re-runs; cached node stays skipped
    expect(mockSendQueryDag.mock.calls.length).toBe(1);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const cachedSkipped = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'cached'
    );
    expect(cachedSkipped).toBeDefined();
  });

  it('downstream consumer reads fresh producer output (not the pre-populated cached value)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const seenPrompts: string[] = [];
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      seenPrompts.push(prompt);
      queryCount++;
      // First call is the always_run producer; subsequent calls are consumers
      yield {
        type: 'assistant',
        content: queryCount === 1 ? 'fresh producer output' : 'consumer result',
      };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const priorCompletedNodes = new Map([['producer', 'STALE_CACHED_VALUE']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-fresh-output',
      testDir,
      {
        name: 'always-run-fresh',
        nodes: [
          { id: 'producer', command: 'producer', always_run: true },
          { id: 'consumer', prompt: 'See: $producer.output', depends_on: ['producer'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // Consumer's prompt should contain the fresh producer output, not the stale cached value
    const consumerPrompt = seenPrompts[1];
    expect(consumerPrompt).toContain('fresh producer output');
    expect(consumerPrompt).not.toContain('STALE_CACHED_VALUE');
  });
});

describe('executeDagWorkflow -- break after result (no hang on subprocess exit)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-break-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Command prompt $ARGUMENTS');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    // Restore default sync generator so later tests aren't affected
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('command/prompt node completes immediately after result — does not block on post-result messages', async () => {
    // Generator yields result then hangs forever (simulates subprocess that won't exit)
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'response' };
      yield { type: 'result', sessionId: 'sess-break' };
      // Subprocess hangs — without break, this blocks until idle timeout
      await new Promise<void>(() => {});
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // Should complete promptly (not hang for 30 min)
    const result = await Promise.race([
      executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        { name: 'break-test', nodes: [{ id: 'n1', command: 'my-cmd' }] },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      ).then(() => 'completed'),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out — break after result not working')), 5000)
      ),
    ]);

    expect(result).toBe('completed');
  });

  it('loop node completes immediately after result — does not block on post-result messages', async () => {
    // Generator yields result then hangs forever
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'All done. COMPLETE' };
      yield { type: 'result', sessionId: 'sess-loop-break' };
      await new Promise<void>(() => {});
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await Promise.race([
      executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'loop-break-test',
          nodes: [
            {
              id: 'loop1',
              loop: { until: 'COMPLETE', max_iterations: 3 },
              prompt: 'Do the thing. Say COMPLETE when done.',
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      ).then(() => 'completed'),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out — break after result not working')), 5000)
      ),
    ]);

    expect(result).toBe('completed');
  });
});

describe('executeDagWorkflow -- terminal node output selection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-terminal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Command prompt $ARGUMENTS');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('returns output of the single terminal node in a linear DAG', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'Final summary text' };
      yield { type: 'result', sessionId: 'sess-linear' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'linear-dag',
        nodes: [
          { id: 'step1', command: 'my-cmd' },
          { id: 'step2', command: 'my-cmd', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(result).toBe('Final summary text');
  });

  it('fails node when the AI stream closes with no assistant output', async () => {
    // Empty assistant output on AI nodes (`command:`/`prompt:`) typically
    // indicates a silent provider rejection or stream interruption that
    // didn't yield a result.isError chunk. Treat it as a node failure
    // rather than a successful empty completion.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 'sess-empty' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'empty-dag', nodes: [{ id: 'only', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('produced no assistant output');
    // Workflow-level failure must propagate, not just the node event.
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });

  it('does NOT fail node when stream yields no assistant text but a structuredOutput is present', async () => {
    // Output-format nodes legitimately produce zero free-form text — the
    // useful payload is the structuredOutput field. The empty-output guard
    // must spare them.
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 'sess-structured',
        structuredOutput: { category: 'math' },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'structured-only-dag',
        nodes: [
          {
            id: 'classify',
            prompt: 'Classify this',
            output_format: { type: 'object', properties: {} },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBe(0);
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedEvents.length).toBeGreaterThan(0);
  });

  it('idle-timeout with zero output produces node_failed, not node_completed', async () => {
    // Regression test for #1807: idle-timeout before first token must fail, not silently complete.
    // The generator yields nothing; idle_timeout fires before any output is produced.
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      // Wait for abort (idle timeout fires abort).
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) {
          resolve();
        } else {
          options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        }
      });
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'idle-timeout-no-output',
        nodes: [
          {
            id: 'classify',
            command: 'my-cmd',
            idle_timeout: 50,
            // Disable retries so the test doesn't wait for retry delays (the
            // "timed out" message matches TRANSIENT patterns, which would trigger
            // the default 2-retry / 3s-delay policy otherwise).
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('timed out with no output');
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedEvents.length).toBe(0);
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });

  it('output_format set but provider returns no structured output → node_failed (Task 8 fail-fast)', async () => {
    // Provider replied with prose only; no structuredOutput on the result chunk.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Sure, the verdict is review.' };
      yield { type: 'result', sessionId: 's' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'outfmt-missing',
        nodes: [
          {
            id: 'classify',
            prompt: 'classify it',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed.length).toBeGreaterThan(0);
    const errMsg = ((failed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('no schema-valid structured output');
  });

  it('output_format structured output failing schema validation → node_failed (Task 7)', async () => {
    // Provider returned a structured object missing the required `verdict` field.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: '{"confidence":0.9}' };
      yield { type: 'result', sessionId: 's', structuredOutput: { confidence: 0.9 } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'outfmt-invalid',
        nodes: [
          {
            id: 'classify',
            prompt: 'classify it',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed.length).toBeGreaterThan(0);
    const errMsg = ((failed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('failed schema validation');
  });

  it('when: referencing a field not in the producer schema FAILS the node (not a silent skip)', async () => {
    // Regression guard: an unresolvable `.field` ref in a `when:` must fail the
    // dependent node (OutputRefError → node_failed), NOT fail-closed-skip it —
    // the exact regression that would silently revert the no-silent-drop fix.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: '{"verdict":"review"}' };
      yield { type: 'result', sessionId: 's', structuredOutput: { verdict: 'review' } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'when-badref',
        nodes: [
          {
            id: 'gate',
            prompt: 'decide',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
          {
            id: 'runme',
            prompt: 'go',
            depends_on: ['gate'],
            when: "$gate.output.nonexistent == 'x'",
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const runmeFailed = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
        (call[0] as Record<string, unknown>).step_name === 'runme'
    );
    expect(runmeFailed).toBeDefined();
    const errMsg = ((runmeFailed![0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('not declared in node');
  });

  it('best-effort provider: malformed-then-fixed structured output recovers within reasks', async () => {
    // Attempt 1 returns structured output missing the required `verdict`; the reask
    // loop re-runs and attempt 2 returns valid output → node COMPLETES (not failed).
    // Costs accumulate across both attempts.
    mockSendQueryDag.mockImplementationOnce(function* () {
      yield { type: 'result', sessionId: 's1', structuredOutput: { other: 'x' }, cost: 0.01 };
    });
    mockSendQueryDag.mockImplementation(function* () {
      yield {
        type: 'result',
        sessionId: 's2',
        structuredOutput: { verdict: 'review' },
        cost: 0.02,
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'reask-recover',
        nodes: [
          {
            id: 'classify',
            prompt: 'decide',
            provider: 'pi',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'pi',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'pi' }
    );

    // sendQuery ran twice (original + 1 reask); node completed, not failed.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completed = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_completed' &&
        (call[0] as Record<string, unknown>).step_name === 'classify'
    );
    const failed = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(completed.length).toBe(1);
    expect(failed.length).toBe(0);
    // Cost accumulates across both attempts (0.01 + 0.02), not just the last pass.
    const cost = ((completed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .cost_usd as number;
    expect(cost).toBeCloseTo(0.03, 5);
  });

  it('best-effort provider: reask exhaustion fails loudly', async () => {
    // Every attempt returns invalid structured output → fail after 1 + maxReasks (3) tries.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'result', sessionId: 's', structuredOutput: { other: 'x' } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'reask-exhaust',
        nodes: [
          {
            id: 'classify',
            prompt: 'decide',
            provider: 'pi',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'pi',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'pi' }
    );

    // 1 initial + 3 reasks = 4 sendQuery calls, then fail-fast.
    expect(mockSendQueryDag.mock.calls.length).toBe(4);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed).toBeDefined();
    const errMsg = ((failed![0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('failed schema validation');
  });

  it('enforced provider does NOT reask on a validation miss (exactly one sendQuery)', async () => {
    // Claude is 'enforced' → maxReasks = 0. A validation miss must fail on the
    // FIRST pass — a regressed gate would silently make 4 API calls per miss.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'result', sessionId: 's', structuredOutput: { other: 'x' } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'enforced-no-reask',
        nodes: [
          {
            id: 'classify',
            prompt: 'decide',
            provider: 'claude',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed).toBeDefined();
  });

  it('best-effort provider: MISSING structured output triggers reask and recovers', async () => {
    // Attempt 1 returns prose with no structuredOutput; attempt 2 returns valid JSON.
    mockSendQueryDag.mockImplementationOnce(function* () {
      yield { type: 'assistant', content: 'Sure, here you go.' };
      yield { type: 'result', sessionId: 's1' };
    });
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'result', sessionId: 's2', structuredOutput: { verdict: 'review' } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'reask-missing',
        nodes: [
          {
            id: 'classify',
            prompt: 'decide',
            provider: 'pi',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'pi',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'pi' }
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completed = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_completed' &&
        (call[0] as Record<string, unknown>).step_name === 'classify'
    );
    expect(completed.length).toBe(1);
  });

  it('best-effort provider: idle-timeout on an output_format node does NOT reask', async () => {
    // Generator hangs → idle_timeout fires → abort. canReask is false (timed out),
    // so exactly one sendQuery and the failure names the timeout, not "prose".
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) resolve();
        else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'reask-idle',
        nodes: [
          {
            id: 'classify',
            prompt: 'decide',
            provider: 'pi',
            idle_timeout: 50,
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          },
        ],
      },
      workflowRun,
      'pi',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'pi' }
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed).toBeDefined();
    const errMsg = ((failed![0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('timed out');
  });

  it('idle-timeout WITH output produces node_completed and sends warning, not node_failed', async () => {
    // The "subprocess hung after AI finished" path must still complete the node, not fail it.
    // Note: no `result` event — the generator yields content then hangs, so idle timeout fires
    // before the generator exits. This is the "subprocess hung without sending result" case.
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      yield { type: 'assistant', content: 'Here is the analysis result.' };
      // Hang until abort signal fires (idle timeout aborts the controller)
      await new Promise<void>(resolve => {
        options?.abortSignal?.addEventListener('abort', () => resolve());
      });
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'idle-timeout-with-output',
        nodes: [{ id: 'step1', command: 'my-cmd', idle_timeout: 50, retry: { max_attempts: 0 } }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBe(0);
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedEvents.length).toBeGreaterThan(0);
    const sentMessages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    expect(sentMessages.some(m => m.includes('completed via idle timeout'))).toBe(true);
  });

  it('fails the run when a node specifies an unknown provider (defense-in-depth at execution time)', async () => {
    // Loader-time validation also catches this (loader.ts iterates dagNodes
    // after parsing), but the dag-executor's resolveNodeProviderAndModel
    // throws as defense-in-depth in case a code path bypasses the loader.
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'unknown-provider-dag',
        nodes: [
          {
            id: 'bad',
            command: 'my-cmd',
            provider: 'claud', // typo
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(store.failWorkflowRun).toHaveBeenCalled();
    // The "unknown provider" detail surfaces on the node_failed event; the
    // workflow-level fail message names the failing node(s).
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const nodeFailedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(nodeFailedData.error).toContain("unknown provider 'claud'");
  });

  it('failure message names the failing node instead of generic summary', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'fail-msg-test',
        nodes: [
          {
            id: 'fail-node',
            command: 'my-cmd',
            provider: 'nonexistent',
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(store.failWorkflowRun).toHaveBeenCalled();
    const failCall = (store.failWorkflowRun as ReturnType<typeof mock>).mock.calls[0];
    const failMsg = failCall[1] as string;
    expect(failMsg).toContain('fail-node failed');
    expect(failMsg).not.toContain('no successful nodes');
  });

  it('excludes intermediate nodes with dependents from terminal set (fan-in DAG)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 3) {
        // Third call is for node 'c' (terminal)
        yield { type: 'assistant', content: 'C final output' };
      } else {
        yield { type: 'assistant', content: `Intermediate output ${callCount}` };
      }
      yield { type: 'result', sessionId: `sess-fanin-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'fanin-dag',
        nodes: [
          { id: 'a', command: 'my-cmd' },
          { id: 'b', command: 'my-cmd' },
          { id: 'c', command: 'my-cmd', depends_on: ['a', 'b'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Only 'c' is terminal (no node depends on it); 'a' and 'b' are not terminal
    expect(result).toBe('C final output');
  });
});

// ---------------------------------------------------------------------------
// Cancel node dispatch
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- cancel node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-cancel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('cancel node transitions run to cancelled and sends message', async () => {
    const store = createMockStore();
    (store.cancelWorkflowRun as Mock<() => Promise<void>>).mockResolvedValue(undefined);
    // Track whether cancelWorkflowRun has been called to simulate status transition
    let cancelled = false;
    (store.cancelWorkflowRun as Mock<() => Promise<void>>).mockImplementation(async () => {
      cancelled = true;
    });
    (store.getWorkflowRunStatus as Mock<() => Promise<string>>).mockImplementation(async () =>
      cancelled ? 'cancelled' : 'running'
    );
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'cancel-test',
        nodes: [
          { id: 'check', bash: 'echo blocked' },
          { id: 'stop', depends_on: ['check'], cancel: 'Precondition failed' },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // cancelWorkflowRun should have been called
    expect((store.cancelWorkflowRun as Mock<() => Promise<void>>).mock.calls.length).toBe(1);

    // A message with the cancel reason should have been sent
    const sendCalls = (platform.sendMessage as Mock<() => Promise<void>>).mock.calls;
    const cancelMsg = sendCalls.find(
      (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Workflow cancelled')
    );
    expect(cancelMsg).toBeDefined();
  });

  it('cancel node with when: false is skipped', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'cancel-skip-test',
        nodes: [
          { id: 'check', bash: 'echo ok' },
          { id: 'stop', depends_on: ['check'], cancel: 'Should not fire', when: '1 == 0' },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // cancelWorkflowRun should NOT have been called (when: condition is false)
    if (store.cancelWorkflowRun && typeof store.cancelWorkflowRun === 'function') {
      expect((store.cancelWorkflowRun as Mock<() => Promise<void>>).mock.calls.length).toBe(0);
    }
  });
});

describe('executeDagWorkflow -- credit exhaustion', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-credit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('marks node as failed when assistant output contains credit exhaustion text', async () => {
    const creditExhaustedQuery = mock(function* () {
      yield { type: 'assistant', content: "You're out of extra usage · resets in 2h" };
      yield { type: 'result', sessionId: 'dag-session-credit' };
    });
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: creditExhaustedQuery,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    });

    const store = createMockStore();
    const deps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('credit-exhaustion-run');

    await executeDagWorkflow(
      deps,
      platform,
      'conv-credit',
      testDir,
      {
        name: 'credit-test',
        nodes: [{ id: 'investigate', prompt: 'Investigate the issue' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // node_failed (not node_completed) must have been stored
    const events = (store.createWorkflowEvent as Mock<() => Promise<void>>).mock.calls.map(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type
    );
    expect(events).toContain('node_failed');
    expect(events).not.toContain('node_completed');

    // Overall workflow should be marked failed
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });
});
describe('executeDagWorkflow -- approval node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-approval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('fresh approval node pauses with extended context (capture_response + on_reject)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-test',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              capture_response: true,
              on_reject: { prompt: 'Fix based on: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI should NOT have been called (fresh approval just pauses)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // pauseWorkflowRun should have been called with extended context
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'review',
      message: 'Approve this plan?',
      captureResponse: true,
      onRejectPrompt: 'Fix based on: $REJECTION_REASON',
      onRejectMaxAttempts: 3,
    });
  });

  it('approval node without capture_response stores empty node output', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-no-capture',
        nodes: [
          {
            id: 'review',
            approval: { message: 'Approve?' },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // pauseWorkflowRun context should NOT have captureResponse
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'review',
      message: 'Approve?',
    });
    // captureResponse should be undefined (not set)
    expect((pauseCalls[0][1] as Record<string, unknown>).captureResponse).toBeUndefined();
  });

  it('on_reject runs AI prompt and re-pauses on rejection resume', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Fixed based on feedback' };
      yield { type: 'result', sessionId: 'reject-fix-session' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    // Simulate a rejection resume — metadata has rejection_reason set by reject handler
    const workflowRun = makeWorkflowRun('reject-resume-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Missing edge case handling',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-reject-resume',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              capture_response: true,
              on_reject: { prompt: 'Fix based on: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI should have been called once (on_reject prompt ran)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The prompt should contain the rejection reason
    const aiPrompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(aiPrompt).toContain('Missing edge case handling');

    // pauseWorkflowRun should have been called (re-paused at approval gate)
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
  });

  it('on_reject does not write node_completed for the approval gate node ID', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Fixed based on feedback' };
      yield { type: 'result', sessionId: 'reject-no-poison-session' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    const workflowRun = makeWorkflowRun('reject-no-poison-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Missing edge case handling',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-no-poison',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              on_reject: { prompt: 'Fix based on: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The on_reject synthetic node must NOT produce a node_completed event with
    // step_name equal to the approval gate's own ID ('review'). If it did, a
    // subsequent resume would find the event via getCompletedDagNodeOutputs and
    // skip the approval gate entirely, bypassing the human gate.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    const completedStepNames = nodeCompletedEvents.map(
      (call: unknown[]) => (call[0] as Record<string, unknown>).step_name
    );
    expect(completedStepNames).not.toContain('review');

    // The synthetic on_reject node MUST produce a node_completed event with the
    // distinct ID 'review:on_reject'. This ensures the synthetic node itself is
    // recorded as completed so it is not re-run on a subsequent resume.
    expect(completedStepNames.filter((n: unknown) => n === 'review:on_reject').length).toBe(1);
  });

  it('on_reject cancels when max_attempts exhausted', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    // rejection_count already at max_attempts
    const workflowRun = makeWorkflowRun('reject-exhausted-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Still not right',
        rejection_count: 3,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-exhausted',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              on_reject: { prompt: 'Fix: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI should NOT have been called (max attempts reached, straight to cancel)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // cancelWorkflowRun should have been called
    const cancelCalls = (store.cancelWorkflowRun as Mock<(id: string) => Promise<void>>).mock.calls;
    expect(cancelCalls.length).toBe(1);

    // pauseWorkflowRun should NOT have been called
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(0);
  });

  it('on_reject with max_attempts: 1 cancels on first rejection', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    const workflowRun = makeWorkflowRun('reject-max1-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 1,
        },
        rejection_reason: 'Bad',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-max1',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve?',
              on_reject: { prompt: 'Fix: $REJECTION_REASON', max_attempts: 1 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Should cancel immediately, no AI call
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expect((store.cancelWorkflowRun as Mock<(id: string) => Promise<void>>).mock.calls.length).toBe(
      1
    );
  });

  it('approval message substitutes $nodeId.output.field references from upstream structured output', async () => {
    // Repro for: approval gates were rendering literal "$gather-context.output.repo_name"
    // instead of resolved values, breaking interactive workflows like atlas-onboard.
    // Parity: prompt/bash/loop/cancel nodes already get substituteNodeOutputRefs;
    // approval.message must too so the human sees concrete values.
    const structuredJson = {
      repo_name: 'hcr-els',
      app_code: 'CCELS',
      frontend_port: 3012,
    };

    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'gather-context.md'), 'Gather context: $USER_MESSAGE');

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: JSON.stringify(structuredJson) };
      yield { type: 'result', sessionId: 'sid-approval-sub', structuredOutput: structuredJson };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('approval-sub-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval-sub',
      testDir,
      {
        name: 'approval-sub-test',
        nodes: [
          {
            id: 'gather-context',
            command: 'gather-context',
            output_format: {
              type: 'object',
              properties: {
                repo_name: { type: 'string' },
                app_code: { type: 'string' },
                frontend_port: { type: 'number' },
              },
            },
          },
          {
            id: 'confirm',
            depends_on: ['gather-context'],
            approval: {
              message:
                'Repo: $gather-context.output.repo_name | App: $gather-context.output.app_code | Port: $gather-context.output.frontend_port',
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // gather-context AI call ran once; approval node does NOT call AI
    expect(mockSendQueryDag.mock.calls.length).toBe(1);

    // pauseWorkflowRun should receive the SUBSTITUTED message, not the literal placeholders
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'confirm',
      message: 'Repo: hcr-els | App: CCELS | Port: 3012',
    });

    // The fix touches FOUR emission sites (safeSendMessage / createWorkflowEvent /
    // pauseWorkflowRun / event-emitter). Assert the other two reachable surfaces too —
    // a future regression at any one of them would otherwise pass this test silently.
    // (Per CodeRabbit review of PR coleam00/Archon#1426.)

    // (a) The chat-surface prompt emitted via platform.sendMessage must contain the
    //     substituted message and must NOT contain literal $gather-context.output refs.
    const sentMessages = (
      platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>
    ).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sentMessages.some(m => m.includes('Repo: hcr-els | App: CCELS | Port: 3012'))).toBe(
      true
    );
    expect(sentMessages.some(m => m.includes('$gather-context.output'))).toBe(false);

    // (b) The persisted approval_requested workflow event's data.message must be substituted.
    const approvalRequestedEvents = (
      store.createWorkflowEvent as Mock<() => Promise<void>>
    ).mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === 'approval_requested'
    );
    expect(approvalRequestedEvents.length).toBe(1);
    expect((approvalRequestedEvents[0][0] as { data: { message: string } }).data.message).toBe(
      'Repo: hcr-els | App: CCELS | Port: 3012'
    );
  });
});
describe('executeDagWorkflow -- env var injection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-env-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), '# Test', {
      flag: 'w',
    }).catch(async () => {
      await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
      await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), '# Test');
    });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes config.envVars as env to sendQuery for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-env-test', nodes: [{ id: 'task', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } }
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg?.env).toEqual({ MY_SECRET: 'abc123' });
  });

  it('does not set env on claudeOptions when config.envVars is empty', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-no-env', nodes: [{ id: 'task', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: {} }
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
    expect(optionsArg?.env).toBeUndefined();
  });
});

describe('executeDagWorkflow -- Claude SDK advanced options', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-sdk-opts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('fails node when SDK returns error_max_budget_usd result', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_max_budget_usd',
        sessionId: 'sid',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'budget-test',
        nodes: [{ id: 'step1', command: 'my-cmd', maxBudgetUsd: 2.5 }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(
      (store.failWorkflowRun as Mock<(id: string, msg: string) => Promise<void>>).mock.calls.length
    ).toBeGreaterThan(0);
  });

  it('error message includes cost cap when maxBudgetUsd is set', async () => {
    // 'ok' runs first (no deps), then 'capped' runs after (depends_on: ['ok'])
    // This ensures both nodes run — 'ok' succeeds, 'capped' hits the budget cap
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        // First call: 'ok' node succeeds
        yield { type: 'assistant', content: 'done' };
        yield { type: 'result', sessionId: 'sid1' };
      } else {
        // Second call: 'capped' node hits budget cap
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_max_budget_usd',
          sessionId: 'sid2',
        };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'budget-msg-test',
        nodes: [
          { id: 'ok', prompt: 'do work first' },
          { id: 'capped', command: 'my-cmd', maxBudgetUsd: 2.5, depends_on: ['ok'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const capMessage = messages.find(m => m.includes('$2.50'));
    expect(capMessage).toBeDefined();
  });

  it('fails node when SDK returns error_during_execution result', async () => {
    // Regression test for #1208: previously we only failed on error_max_budget_usd
    // and silently broke on all other isError subtypes, letting failed nodes
    // masquerade as successes with empty output.
    mockSendQueryDag.mockImplementation(function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['Tool call failed: permission denied'],
        sessionId: 'sid-err',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'err-exec-test',
        nodes: [{ id: 'step1', command: 'my-cmd' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The node_failed event should carry the subtype and SDK errors detail
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('error_during_execution');
    expect(failedData.error).toContain('permission denied');
  });

  it('does NOT fail node when SDK returns isError: true + errorSubtype: success', async () => {
    // Regression test for #1425: stop_sequence terminations under the Claude
    // SDK contract carry is_error: true + subtype: 'success'. The provider
    // normalises this, but the executor keeps an explicit guard so a future
    // provider regression or a third-party IAgentProvider that forwards the
    // SDK pair raw cannot reintroduce the "SDK returned success" false-failure.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'classified output' };
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'success',
        stopReason: 'stop_sequence',
        sessionId: 'sid-stop',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'success-stop-seq-test',
        nodes: [{ id: 'classify', command: 'my-cmd' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents).toHaveLength(0);

    const completeCalls = (store.completeWorkflowRun as ReturnType<typeof mock>).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
  });

  it('forwards workflow-level effort to node when no per-node override', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'workflow-effort-test',
        nodes: [{ id: 'step1', command: 'my-cmd' }],
        effort: 'high',
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('high');
  });

  it('per-node effort overrides workflow-level effort', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'node-effort-override-test',
        nodes: [{ id: 'step1', command: 'my-cmd', effort: 'max' }],
        effort: 'low',
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('max');
  });

  it('warns user when Codex node has Claude-only options (effort)', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'codex-claude-opts-test',
        nodes: [{ id: 'step1', command: 'my-cmd', provider: 'codex', effort: 'high' }],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('effort') && m.toLowerCase().includes('codex'));
    expect(warning).toBeDefined();
  });
});

describe('executeDagWorkflow -- cost tracking', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes total_cost_usd to completeWorkflowRun when node yields cost', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield { type: 'result', sessionId: 'sid-cost', cost: 0.0042 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-cost', nodes: [{ id: 'step', prompt: 'Do thing.' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toEqual({
      node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      total_cost_usd: 0.0042,
    });
  });

  it('sums total_cost_usd across multiple sequential nodes', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      yield { type: 'assistant', content: `Step ${String(callCount)} output` };
      yield { type: 'result', sessionId: `sid-${String(callCount)}`, cost: 0.001 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-cost-multi',
        nodes: [
          { id: 'step1', prompt: 'Step 1.' },
          { id: 'step2', prompt: 'Step 2.', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toMatchObject({ total_cost_usd: 0.002 });
  });

  it('omits total_cost_usd from completeWorkflowRun when no cost yielded', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Some output' };
      yield { type: 'result', sessionId: 'sid-no-cost' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-no-cost', nodes: [{ id: 'step', prompt: 'Do thing.' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).not.toHaveProperty('total_cost_usd');
  });

  it('accumulates cost across loop iterations and includes in completeWorkflowRun', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount < 3) {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: `loop-sid-${String(callCount)}`, cost: 0.001 };
      } else {
        yield { type: 'assistant', content: 'All done! <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: `loop-sid-${String(callCount)}`, cost: 0.002 };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-loop-cost',
        nodes: [
          {
            id: 'my-loop',
            loop: { prompt: 'Work.', until: 'COMPLETE', max_iterations: 5 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // 3 iterations: 0.001 + 0.001 + 0.002 = 0.004
    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toMatchObject({ total_cost_usd: 0.004 });
  });
});

describe('executeDagWorkflow -- script nodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-script-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('inline bun script executes and captures stdout', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-test-run-id', {
      workflow_name: 'script-test',
      conversation_id: 'conv-script',
      user_message: 'script test message',
    });

    const scriptNode: ScriptNode = {
      id: 'inline-bun',
      script: 'console.log("hello from bun")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script',
      testDir,
      { name: 'script-inline-bun-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Script node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('inline bun script output available for downstream substitution', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-test-run-id', {
      workflow_name: 'script-test',
      conversation_id: 'conv-script',
      user_message: 'script test message',
    });

    // Write a command file for the downstream AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'use-result.md'), 'Use: $compute.output');

    const nodes: DagNode[] = [
      { id: 'compute', script: 'console.log("42")', runtime: 'bun' },
      { id: 'use', command: 'use-result', depends_on: ['compute'] },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script',
      testDir,
      { name: 'script-subst-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI client called for the downstream AI node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain('42');
  });

  it('inline uv script executes and captures stdout', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-uv-run-id', {
      workflow_name: 'script-uv-test',
      conversation_id: 'conv-script-uv',
      user_message: 'uv test message',
    });

    const scriptNode: ScriptNode = {
      id: 'inline-uv',
      script: 'print("hello from python")',
      runtime: 'uv',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script-uv',
      testDir,
      { name: 'script-inline-uv-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Script node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('named bun script executes from .archon/scripts/', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-named-run-id', {
      workflow_name: 'script-named-test',
      conversation_id: 'conv-named',
      user_message: 'named test',
    });

    // Create a named script
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'greet.ts'), 'console.log("named script output")');

    const scriptNode: ScriptNode = {
      id: 'run-greet',
      script: 'greet',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-named',
      testDir,
      { name: 'named-script-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('non-zero exit code results in failed state', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-fail-run-id', {
      workflow_name: 'script-fail-test',
      conversation_id: 'conv-fail',
      user_message: 'fail test',
    });

    const scriptNode: ScriptNode = {
      id: 'fail-script',
      script: 'process.exit(1)',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-fail',
      testDir,
      { name: 'script-fail-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('failed') && m.includes('fail-script'));
    expect(failMsg).toBeDefined();
  });

  it('failure message strips the "Command failed: bun -e <body>" prefix and stays small', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-1389-run-id', {
      workflow_name: 'script-1389',
      conversation_id: 'conv-1389s',
      user_message: 'test',
    });

    // 500 × 7 chars = 3.5 KB — larger than SUBPROCESS_ERROR_MAX_CHARS (2 KB),
    // so any leak of the full script body via err.message would violate the length
    // assertion below. Block-comment padding (no newlines) avoids Windows execFile
    // arg truncation at \n that would cause bun to exit 0 on the comment-only prefix.
    const paddingAboveMax = '/* p */'.repeat(500);
    const scriptNode: ScriptNode = {
      id: 'fail-script-1389',
      script: `${paddingAboveMax} this is not valid javascript`,
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-1389s',
      testDir,
      { name: 'script-1389', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'fail-script-1389'
    );
    expect(failedEvent).toBeDefined();
    const errorMsg = (failedEvent![0] as { data: { error: string } }).data.error;
    expect(errorMsg).toContain("Script node 'fail-script-1389' failed");
    expect(errorMsg).not.toContain('Command failed:');
    expect(errorMsg).not.toContain('padding line padding line padding line');
    // 2 KB diagnostic cap + label prefix + truncation marker should stay under
    // 2.1 KB. Bumping SUBPROCESS_ERROR_MAX_CHARS would trip this.
    expect(errorMsg.length).toBeLessThan(2100);
    // Bun emits `error: <description>\n    at [eval]:L:C` for parse failures —
    // the location marker is the strongest signal that the diagnostic survived.
    expect(errorMsg).toContain('[eval]');
  });

  it('timeout kills subprocess', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-timeout-run-id', {
      workflow_name: 'script-timeout-test',
      conversation_id: 'conv-timeout',
      user_message: 'timeout test',
    });

    const scriptNode: ScriptNode = {
      id: 'slow-script',
      // Bun inline script that sleeps longer than the timeout
      script: 'await new Promise(r => setTimeout(r, 30000))',
      runtime: 'bun',
      timeout: 500,
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-timeout',
      testDir,
      { name: 'script-timeout-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    // Workflow fails because the only node failed (timeout)
    const failMsg = messages.find((m: string) => m.includes('failed') && m.includes('slow-script'));
    expect(failMsg).toBeDefined();
  }, 10000);

  it('stderr output is sent to the user', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-stderr-run-id', {
      workflow_name: 'script-stderr-test',
      conversation_id: 'conv-stderr',
      user_message: 'stderr test',
    });

    const scriptNode: ScriptNode = {
      id: 'stderr-script',
      // Write to both stderr and stdout
      script: 'process.stderr.write("error detail\\n"); console.log("done")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-stderr',
      testDir,
      { name: 'script-stderr-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const stderrMsg = messages.find((m: string) => m.includes('error detail'));
    expect(stderrMsg).toBeDefined();
    expect(stderrMsg).toContain('stderr-script');
  });

  it('$WORKFLOW_ID and $ARTIFACTS_DIR are substituted into script text', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('wf-subst-run-id', {
      workflow_name: 'script-subst-test',
      conversation_id: 'conv-subst',
      user_message: 'subst test',
    });

    const artifactsDir = join(testDir, 'artifacts');

    // Write a downstream command so we can inspect the substituted prompt
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'check-output.md'), 'Got: $script-out.output');

    const nodes: DagNode[] = [
      {
        id: 'script-out',
        // Print the run ID and artifacts dir — after substitution these are real values
        script: 'console.log("id=$WORKFLOW_ID artifacts=$ARTIFACTS_DIR")',
        runtime: 'bun',
      },
      { id: 'check', command: 'check-output', depends_on: ['script-out'] },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-subst',
      testDir,
      { name: 'script-subst-vars', nodes },
      workflowRun,
      'claude',
      undefined,
      artifactsDir,
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The downstream AI node should have received the substituted output
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    // The script output should contain the actual run ID (not the literal variable name)
    expect(prompt).toContain('wf-subst-run-id');
    expect(prompt).not.toContain('$WORKFLOW_ID');
  });

  it('named script not found at runtime results in failed state and platform message', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-notfound-run-id', {
      workflow_name: 'script-notfound-test',
      conversation_id: 'conv-notfound',
      user_message: 'notfound test',
    });

    // Do NOT create .archon/scripts/missing.ts — the script should fail to resolve
    const scriptNode: ScriptNode = {
      id: 'gone-script',
      script: 'missing',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-notfound',
      testDir,
      { name: 'script-notfound-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const notFoundMsg = messages.find((m: string) => m.includes('not found in .archon/scripts/'));
    expect(notFoundMsg).toBeDefined();
  });

  it('bun script node does not leak repo .env from execution cwd (#1135)', async () => {
    // Regression test: place a .env with a marker in the execution cwd.
    // The bun script must NOT see it because --no-env-file is passed.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('env-leak-run-id', {
      workflow_name: 'env-leak-test',
      conversation_id: 'conv-env-leak',
      user_message: 'env leak test',
    });

    // Write a .env with a marker in the script execution cwd
    await writeFile(join(testDir, '.env'), 'LEAKED_REPO_SECRET=should_not_appear\n');

    const scriptNode: ScriptNode = {
      id: 'env-check',
      script: 'console.log(process.env.LEAKED_REPO_SECRET ?? "CLEAN")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-env-leak',
      testDir,
      { name: 'env-leak-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The node output should be "CLEAN" — the repo .env was not loaded
    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'env-check'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toBe(
      'CLEAN'
    );
  });

  it('passes config.envVars to script subprocesses', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-env-run-id');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script-env',
      testDir,
      {
        name: 'script-env-test',
        nodes: [{ id: 'inline-bun', script: 'console.log("ok")', runtime: 'bun' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } }
    );

    expect(execSpy).toHaveBeenCalledWith(
      'bun',
      ['--no-env-file', '-e', 'console.log("ok")'],
      expect.objectContaining({
        env: expect.objectContaining({ MY_SECRET: 'abc123' }),
      })
    );
    execSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// MCP plugin-noise filtering helpers
// ---------------------------------------------------------------------------

describe('parseMcpFailureServerNames', () => {
  it('extracts entries (name + segment) from a well-formed message', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    const entries = parseMcpFailureServerNames(
      'MCP server connection failed: telegram (disconnected), github (timeout)'
    );
    expect(entries).toEqual([
      { name: 'telegram', segment: 'telegram (disconnected)' },
      { name: 'github', segment: 'github (timeout)' },
    ]);
  });

  it('returns empty array for unrelated messages', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    expect(parseMcpFailureServerNames('⚠️ Something else')).toEqual([]);
    expect(parseMcpFailureServerNames('')).toEqual([]);
  });

  it('deduplicates repeated entries (first segment wins)', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    const entries = parseMcpFailureServerNames(
      'MCP server connection failed: foo (a), foo (b), bar (c)'
    );
    expect(entries).toEqual([
      { name: 'foo', segment: 'foo (a)' },
      { name: 'bar', segment: 'bar (c)' },
    ]);
  });

  it('handles a single entry without status parens gracefully', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    expect(parseMcpFailureServerNames('MCP server connection failed: solo')).toEqual([
      { name: 'solo', segment: 'solo' },
    ]);
  });

  it('drops empty segments from trailing/leading commas', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    expect(parseMcpFailureServerNames('MCP server connection failed: a (x), , b (y)')).toEqual([
      { name: 'a', segment: 'a (x)' },
      { name: 'b', segment: 'b (y)' },
    ]);
  });
});

describe('loadConfiguredMcpServerNames', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mcp-names-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty set when nodeMcpPath is undefined', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    const names = await loadConfiguredMcpServerNames(undefined, testDir);
    expect(names.size).toBe(0);
  });

  it('returns server names for a valid JSON config (relative path)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    await writeFile(
      join(testDir, 'mcp.json'),
      JSON.stringify({ foo: { command: 'x' }, bar: { command: 'y' } })
    );
    const names = await loadConfiguredMcpServerNames('mcp.json', testDir);
    expect([...names].sort()).toEqual(['bar', 'foo']);
  });

  it('returns server names for an absolute path', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    const absolutePath = join(testDir, 'abs.json');
    await writeFile(absolutePath, JSON.stringify({ baz: {} }));
    const names = await loadConfiguredMcpServerNames(absolutePath, '/nonexistent/cwd');
    expect([...names]).toEqual(['baz']);
  });

  it('returns empty set when file is missing (no crash)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    const names = await loadConfiguredMcpServerNames('missing.json', testDir);
    expect(names.size).toBe(0);
  });

  it('returns empty set for invalid JSON (provider surfaces its own error)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    await writeFile(join(testDir, 'broken.json'), '{ not-json');
    const names = await loadConfiguredMcpServerNames('broken.json', testDir);
    expect(names.size).toBe(0);
  });

  it('returns empty set when JSON is an array (not an object of servers)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    await writeFile(join(testDir, 'arr.json'), '["foo","bar"]');
    const names = await loadConfiguredMcpServerNames('arr.json', testDir);
    expect(names.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MCP plugin-noise filtering — end-to-end through executeDagWorkflow
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- MCP failure filtering', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-mcp-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'cmd prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  async function runWithSystemChunk(
    systemContent: string,
    nodeMcpPath?: string
  ): Promise<IWorkflowPlatform> {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'system', content: systemContent };
      yield { type: 'assistant', content: 'ok' };
      yield { type: 'result', sessionId: 'sess' };
    });

    const platform = createMockPlatform();
    await executeDagWorkflow(
      createMockDeps(),
      platform,
      'conv-mcp-filter',
      testDir,
      {
        name: 'mcp-filter-test',
        nodes: [{ id: 'review', command: 'my-cmd', ...(nodeMcpPath ? { mcp: nodeMcpPath } : {}) }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );
    return platform;
  }

  function mcpMessages(platform: IWorkflowPlatform): string[] {
    const calls = (platform.sendMessage as Mock<typeof platform.sendMessage>).mock.calls;
    return calls
      .map(c => c[1] as string)
      .filter(m => m.startsWith('MCP server connection failed:') || m.startsWith('⚠️'));
  }

  it('forwards only workflow-configured failures and preserves status detail', async () => {
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ 'workflow-server': {} }));
    const platform = await runWithSystemChunk(
      'MCP server connection failed: workflow-server (timeout), telegram (disconnected)',
      'mcp.json'
    );

    const sent = mcpMessages(platform);
    expect(sent).toEqual(['MCP server connection failed: workflow-server (timeout)']);
  });

  it('suppresses MCP message entirely when all failures are user plugins', async () => {
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ 'workflow-server': {} }));
    const platform = await runWithSystemChunk(
      'MCP server connection failed: telegram (disconnected), notion (timeout)',
      'mcp.json'
    );

    expect(mcpMessages(platform)).toEqual([]);
  });

  it('suppresses everything when node has no mcp: config (all failures are plugin noise)', async () => {
    const platform = await runWithSystemChunk(
      'MCP server connection failed: telegram (disconnected)'
    );

    expect(mcpMessages(platform)).toEqual([]);
  });

  it('forwards ⚠️ provider warnings verbatim', async () => {
    const platform = await runWithSystemChunk('⚠️ Haiku does not support MCP');

    expect(mcpMessages(platform)).toEqual(['⚠️ Haiku does not support MCP']);
  });
});

// ---------------------------------------------------------------------------
// Streaming cancel-check policy (during-streaming paused tolerance)
// ---------------------------------------------------------------------------

describe('shouldContinueStreamingForStatus', () => {
  it('continues when status is running', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('running')).toBe(true);
  });

  it('continues when status is paused (sibling approval node in same layer)', async () => {
    // The key invariant: a concurrent approval node can pause the run while a
    // streaming AI node is mid-response. The streaming node must finish its
    // own output — workflow progression is gated by the approval node, not
    // by tearing down unrelated in-flight streams.
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('paused')).toBe(true);
  });

  it('aborts when status is null (run deleted)', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus(null)).toBe(false);
  });

  it('aborts when status is cancelled', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('cancelled')).toBe(false);
  });

  it('aborts when status is failed', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('failed')).toBe(false);
  });

  it('aborts when status is completed', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('completed')).toBe(false);
  });

  it('aborts on any unrecognized state', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('pending')).toBe(false);
    expect(shouldContinueStreamingForStatus('invalid-status')).toBe(false);
  });
});

describe('executeDagWorkflow -- final status derivation', () => {
  // Invariant: if ANY non-skipped node has failed status, the run must be
  // marked 'failed' — never 'completed' — regardless of how many other nodes
  // succeeded. This covers the anyFailed branch in executeDagWorkflow
  // (dag-executor.ts ~line 2956), which had no direct test coverage.
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('one success + one independent failure -> failWorkflowRun, not completeWorkflowRun', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-1');

    const nodes: DagNode[] = [
      { id: 'pass', bash: 'echo ok' } as BashNode,
      { id: 'fail', bash: 'exit 1' } as BashNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-status',
      testDir,
      { name: 'status-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('fail')
    );

    // Confirm the failure message names the failing node
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('completed with failures'));
    expect(failMsg).toBeDefined();
  });

  it('multiple successes + one failure -> failWorkflowRun, not completeWorkflowRun', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-2');

    const nodes: DagNode[] = [
      { id: 'a', bash: 'echo a' } as BashNode,
      { id: 'b', bash: 'echo b' } as BashNode,
      { id: 'c', bash: 'echo c' } as BashNode,
      { id: 'fail', bash: 'exit 1' } as BashNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-status',
      testDir,
      { name: 'status-test-multi', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('fail')
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('completed with failures'));
    expect(failMsg).toBeDefined();
  });

  it('trigger_rule: none_failed skips dependent node + anyFailed still marks run failed', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-3');

    // Layer 1: A and B run in parallel. B fails.
    // Layer 2: C depends on B with trigger_rule: none_failed — so C is skipped.
    // Expected: anyFailed=true (from B), so run must be marked failed even though C is only skipped.
    const nodes: DagNode[] = [
      { id: 'a', bash: 'echo a' } as BashNode,
      { id: 'b', bash: 'exit 1' } as BashNode,
      { id: 'c', bash: 'echo c', depends_on: ['b'], trigger_rule: 'none_failed' } as BashNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-status',
      testDir,
      { name: 'status-test-skip', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('b')
    );
  });
});

describe('provider resolution -- regression for #1610', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'response' };
      yield { type: 'result', sessionId: 'session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('node with no provider annotation routes to workflowProvider (codex), not to model-implied provider', async () => {
    // Regression: a node with model: opus[1m] but no provider: must route to
    // workflowProvider ('codex' when defaultAssistant: codex), not to 'claude'.
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-provider',
      testDir,
      // Node has model: opus[1m] but NO provider: — must inherit workflowProvider
      {
        name: 'provider-regression',
        nodes: [{ id: 'implement', command: 'my-cmd', model: 'opus[1m]' }],
      },
      workflowRun,
      'codex', // workflowProvider (simulates defaultAssistant: codex)
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    // getAgentProvider must have been called with 'codex', not 'claude'
    expect(mockGetAgentProviderDag).toHaveBeenCalledWith('codex');
    expect(mockGetAgentProviderDag).not.toHaveBeenCalledWith('claude');
  });

  it('node with explicit provider: claude routes to claude even when workflowProvider is codex', async () => {
    // When provider: claude is set on the node, it must override workflowProvider.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-provider',
      testDir,
      // Node has both model: opus[1m] AND provider: claude
      {
        name: 'provider-explicit',
        nodes: [{ id: 'implement', command: 'my-cmd', model: 'opus[1m]', provider: 'claude' }],
      },
      workflowRun,
      'codex', // workflowProvider
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    // getAgentProvider must have been called with 'claude'
    expect(mockGetAgentProviderDag).toHaveBeenCalledWith('claude');
  });
});

describe('bundled opus nodes -- provider annotation invariant (#1610)', () => {
  it('every bundled node with an opus model has provider: claude at the node or workflow level', async () => {
    // Resolve the defaults directory relative to this package (same logic as getAppArchonBasePath).
    // import.meta.dir = packages/workflows/src → go up 3 levels to repo root → .archon/workflows/defaults
    const repoRoot = join(import.meta.dir, '..', '..', '..');
    const defaultsDir = join(repoRoot, '.archon', 'workflows', 'defaults');

    const { readdir, readFile: readFileFs } = await import('fs/promises');
    const files = (await readdir(defaultsDir)).filter(f => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const src = await readFileFs(join(defaultsDir, file), 'utf-8');
      const result = parseWorkflow(src, file);
      if (!('workflow' in result)) continue; // skip load errors

      const wf = result.workflow;
      if (!('nodes' in wf) || !wf.nodes) continue; // skip non-DAG workflows

      const workflowProvider: string | undefined = (wf as { provider?: string }).provider;

      for (const n of wf.nodes) {
        const nodeModel: string | undefined = (n as { model?: string }).model;
        if (!nodeModel || !nodeModel.toLowerCase().includes('opus')) continue;

        const nodeProvider: string | undefined = (n as { provider?: string }).provider;
        const hasExplicitClaude = nodeProvider === 'claude' || workflowProvider === 'claude';

        expect(hasExplicitClaude).toBe(true);
        if (!hasExplicitClaude) {
          // Surface which file+node is missing the annotation
          throw new Error(
            `${file}: node '${(n as { id?: string }).id ?? '?'}' has model '${nodeModel}' but no provider: claude at node or workflow level`
          );
        }
      }
    }
  });
});

describe('executeDagWorkflow -- typed artifacts (output_type)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-typed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'new-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('node with output_type writes nodes/<id>.md + .meta.json with the declared type', async () => {
    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'typed-test',
        nodes: [{ id: 'planner', command: 'my-cmd', output_type: 'plan' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const body = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    expect(body).toBe('AI response');
    const meta = JSON.parse(
      await readFile(join(testDir, 'artifacts', 'nodes', 'planner.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({
      nodeId: 'planner',
      outputType: 'plan',
      runId: 'dag-test-run-id',
      path: join('nodes', 'planner.md'),
      // sessionId is propagated from the node output into the metadata.
      sessionId: 'new-session-id',
    });
    expect(typeof meta.producedAt).toBe('string');
  });

  it('bash node with output_type writes a sidecar with no sessionId', async () => {
    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'bash-typed',
        nodes: [{ id: 'metrics', bash: 'echo "result-data"', output_type: 'metrics' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const body = await readFile(join(testDir, 'artifacts', 'nodes', 'metrics.md'), 'utf8');
    expect(body).toContain('result-data');
    const meta = JSON.parse(
      await readFile(join(testDir, 'artifacts', 'nodes', 'metrics.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({ nodeId: 'metrics', outputType: 'metrics' });
    // Bash nodes have no provider session — the field is omitted, not null.
    expect('sessionId' in meta).toBe(false);
    // Bash node does not invoke the AI client.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('artifact write failure is non-fatal — the node still completes', async () => {
    // Force writeNodeArtifact to throw by putting a FILE where the nodes/ dir must
    // go, so its mkdir fails. The node must still complete (best-effort write).
    const artifactsDir = join(testDir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, 'nodes'), 'not a directory', 'utf8');

    // Resolves without throwing — the best-effort catch swallows the write failure.
    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'typed-fail',
        nodes: [{ id: 'planner', command: 'my-cmd', output_type: 'plan' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      artifactsDir,
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The node executed despite the artifact write being impossible.
    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
  });

  it('node without output_type writes no sidecar artifact', async () => {
    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'untyped-test',
        nodes: [{ id: 'planner', command: 'my-cmd' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    let wrote = true;
    try {
      await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(false);
  });
});

describe('executeDagWorkflow -- persist_session', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'new-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('persist_session: true with no prior row → fresh resumeSessionId, upsert on completion', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      mockDeps,
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const getMock = store.getWorkflowNodeSession as Mock<typeof store.getWorkflowNodeSession>;
    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(getMock).toHaveBeenCalledWith({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
    });

    const resumeSessionArg = mockSendQueryDag.mock.calls[0][2];
    expect(resumeSessionArg).toBeUndefined();

    expect(upsertMock).toHaveBeenCalledWith({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'new-session-id',
      last_run_id: 'dag-test-run-id',
    });
  });

  it('persist_session: true with prior row → resumeSessionId loaded, upsert with new id', async () => {
    const store = createMockStore();
    (store.getWorkflowNodeSession as Mock<typeof store.getWorkflowNodeSession>).mockResolvedValue({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'prior-session-id',
      last_run_id: 'prior-run',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    });
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      mockDeps,
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls[0][2]).toBe('prior-session-id');
    // A warm resume (resumed not false) runs the node exactly once — never replayed.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(upsertMock.mock.calls[0][0]).toEqual({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'new-session-id',
      last_run_id: 'dag-test-run-id',
    });
  });

  it('persist_session resume returns cold (resumed:false) → surfaced to user, no re-run, fresh id persisted', async () => {
    const store = createMockStore();
    (store.getWorkflowNodeSession as Mock<typeof store.getWorkflowNodeSession>).mockResolvedValue({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'prior-session-id',
      last_run_id: 'prior-run',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    });
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    mockSendQueryDag.mockClear();
    // The provider could not resume the prior session and ran cold (already a
    // clean fresh session). The executor must keep this run, not re-run it.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'cold run' };
      yield { type: 'result', sessionId: 'cold-id', resumed: false };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Ran exactly once — a cold resume is NOT replayed (the cold run is already fresh).
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(mockSendQueryDag.mock.calls[0][2]).toBe('prior-session-id');
    // The cold resume was surfaced to the user — never silent.
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    // The cold run's own fresh session id is what gets persisted for next time.
    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(upsertMock.mock.calls[0][0]).toMatchObject({ provider_session_id: 'cold-id' });
  });

  // --- #1846: cross-invocation artifact scope + cold-resume pointer recovery ---

  /** Arm the mocks for a cold resume: a persisted prior session that the provider
   *  reports back as not resumed (fresh fallback). */
  function armColdResume(store: ReturnType<typeof createMockStore>): void {
    (store.getWorkflowNodeSession as Mock<typeof store.getWorkflowNodeSession>).mockResolvedValue({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'prior-session-id',
      last_run_id: 'prior-run',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'cold run' };
      yield { type: 'result', sessionId: 'cold-id', resumed: false };
    });
  }

  it('cold resume with prior scope artifacts → warning carries a by-reference pointer', async () => {
    const scopeDir = join(testDir, 'scope-artifacts');
    // A PRIOR invocation left a typed artifact in the stable scope dir.
    await writeNodeArtifact(
      scopeDir,
      {
        nodeId: 'planner',
        outputType: 'plan',
        runId: 'prior-run',
        producedAt: '2026-05-01T00:00:00Z',
      },
      'the prior plan'
    );
    const store = createMockStore();
    armColdResume(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      createMockDeps(store),
      platform,
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeDir
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    const coldMessage = messages.find(m => m.includes('could not resume the prior session'));
    expect(coldMessage).toBeDefined();
    // By reference: the message names the artifact file's path — never its content.
    expect(coldMessage).toContain('available for recovery');
    expect(coldMessage).toContain(join(scopeDir, 'nodes', 'planner.md'));
    expect(coldMessage).not.toContain('the prior plan');
    // The #1842 invariant holds: the cold run is kept, never replayed.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('cold resume with scope artifacts only from the CURRENT run → plain warning, no pointer', async () => {
    const scopeDir = join(testDir, 'scope-artifacts');
    // Only this run's own mirror exists — it recovers nothing.
    await writeNodeArtifact(
      scopeDir,
      {
        nodeId: 'planner',
        outputType: 'plan',
        runId: 'dag-test-run-id',
        producedAt: '2026-05-01T00:00:00Z',
      },
      'this run output'
    );
    const store = createMockStore();
    armColdResume(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      createMockDeps(store),
      platform,
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeDir
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    expect(messages.some(m => m.includes('available for recovery'))).toBe(false);
  });

  it('cold resume with an empty/absent scope dir → plain warning, no pointer', async () => {
    const store = createMockStore();
    armColdResume(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      createMockDeps(store),
      platform,
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      join(testDir, 'scope-artifacts-never-created')
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    expect(messages.some(m => m.includes('available for recovery'))).toBe(false);
  });

  it('persist node with output_type mirrors its typed sidecar into the scope dir', async () => {
    const scopeDir = join(testDir, 'scope-artifacts');

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true, output_type: 'plan' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeDir
    );

    // Written to BOTH the per-run dir and the durable scope dir.
    const runCopy = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    const scopeCopy = await readFile(join(scopeDir, 'nodes', 'planner.md'), 'utf8');
    expect(runCopy).toBe('AI response');
    expect(scopeCopy).toBe('AI response');
    const scopeMeta = JSON.parse(
      await readFile(join(scopeDir, 'nodes', 'planner.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(scopeMeta).toMatchObject({
      nodeId: 'planner',
      outputType: 'plan',
      runId: 'dag-test-run-id',
    });
  });

  it('non-persist node with output_type does NOT mirror into the scope dir', async () => {
    const scopeDir = join(testDir, 'scope-artifacts');

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        // scope dir present (another node opted in), but THIS node doesn't persist.
        nodes: [{ id: 'planner', command: 'my-cmd', output_type: 'plan' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeDir
    );

    // Run-dir sidecar exists; the scope dir stays untouched.
    const runCopy = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    expect(runCopy).toBe('AI response');
    let scopeWrote = true;
    try {
      await readFile(join(scopeDir, 'nodes', 'planner.md'), 'utf8');
    } catch {
      scopeWrote = false;
    }
    expect(scopeWrote).toBe(false);
  });

  it('scope mirror write failure is non-fatal — node completes, run-dir sidecar intact', async () => {
    const scopeDir = join(testDir, 'scope-artifacts');
    // Force the scope write to fail: a FILE where the nodes/ dir must go.
    await mkdir(scopeDir, { recursive: true });
    await writeFile(join(scopeDir, 'nodes'), 'not a directory', 'utf8');

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true, output_type: 'plan' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeDir
    );

    // Node ran and the run-dir sidecar was still written (mirror is best-effort).
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const runCopy = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    expect(runCopy).toBe('AI response');
  });

  it('persist_session: true but provider returns no sessionId → delete stale row', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result' }; // no sessionId
    });
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      mockDeps,
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    const deleteMock = store.deleteWorkflowNodeSessions as Mock<
      typeof store.deleteWorkflowNodeSessions
    >;
    expect(upsertMock).not.toHaveBeenCalled();
    // Provider is included in the filter so a stale-row cleanup under provider B
    // does not wipe provider A's saved row for the same node.
    expect(deleteMock).toHaveBeenCalledWith({
      workflow_name: 'persist-test',
      scope_key: 'conv-dag',
      node_id: 'planner',
      provider: 'claude',
    });
  });

  it('persist_session unset → no store interaction', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      mockDeps,
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'no-persist',
        nodes: [{ id: 'planner', command: 'my-cmd' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(store.getWorkflowNodeSession).not.toHaveBeenCalled();
    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
    expect(store.deleteWorkflowNodeSessions).not.toHaveBeenCalled();
  });

  it('workflow.persist_sessions: true + node.persist_session: false → node opts out', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      mockDeps,
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'wf-default-on',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: false }],
        persist_sessions: true,
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(store.getWorkflowNodeSession).not.toHaveBeenCalled();
    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
  });

  it("node.context: 'fresh' bypasses persistence even when persist_session: true", async () => {
    const store = createMockStore();
    (store.getWorkflowNodeSession as Mock<typeof store.getWorkflowNodeSession>).mockResolvedValue({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'prior-id',
      last_run_id: null,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    });
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      mockDeps,
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true, context: 'fresh' }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(store.getWorkflowNodeSession).not.toHaveBeenCalled();
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
  });

  it('persist_session: true on non-resume-capable provider → throws clear error', async () => {
    // Provider with sessionResume: false
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'no-resume',
      getCapabilities: () => ({
        ...mockClaudeCapabilities(),
        sessionResume: false,
      }),
    }));

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // executeDagWorkflow catches per-node errors and emits a failure message.
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const errMsg = messages.find(m => m.includes('persist_session') && m.includes('sessionResume'));
    expect(errMsg).toBeDefined();
    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
  });

  it('workflow.persist_sessions: true + node unset → node inherits persistence', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      mockDeps,
      createMockPlatform(),
      'conv-dag',
      testDir,
      {
        name: 'wf-inherit',
        nodes: [{ id: 'planner', command: 'my-cmd' }],
        persist_sessions: true,
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(store.getWorkflowNodeSession).toHaveBeenCalledWith({
      workflow_name: 'wf-inherit',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
    });
    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(upsertMock).toHaveBeenCalledWith({
      workflow_name: 'wf-inherit',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'new-session-id',
      last_run_id: 'dag-test-run-id',
    });
  });

  it('persist_session lookup failure → node runs fresh and upserts (non-fatal)', async () => {
    const store = createMockStore();
    (store.getWorkflowNodeSession as Mock<typeof store.getWorkflowNodeSession>).mockRejectedValue(
      new Error('DB timeout')
    );
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Lookup threw → node still runs, with no resume session.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // The successful node still persists its new session id.
    expect(store.upsertWorkflowNodeSession).toHaveBeenCalled();
    // The user is warned the session could not be loaded.
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const warned = sendMessage.mock.calls
      .map((call: unknown[]) => call[1] as string)
      .some(m => m.includes('persisted session') && m.includes('planner'));
    expect(warned).toBe(true);
  });

  it('persist_session upsert failure → node still completes and user is warned (non-fatal)', async () => {
    const store = createMockStore();
    (
      store.upsertWorkflowNodeSession as Mock<typeof store.upsertWorkflowNodeSession>
    ).mockRejectedValue(new Error('write error'));
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'persist-test',
        nodes: [{ id: 'planner', command: 'my-cmd', persist_session: true }],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Upsert threw, but the node executed (sendQuery ran) and the user was warned —
    // the failure did not abort the node.
    expect(mockSendQueryDag).toHaveBeenCalled();
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const warned = sendMessage.mock.calls
      .map((call: unknown[]) => call[1] as string)
      .some(m => m.includes('Could not persist') && m.includes('planner'));
    expect(warned).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Completion telemetry
//
// captureWorkflowCompleted is mocked as a no-op; without these assertions a
// dropped call at any of the three terminal sites (success / partial-failure /
// no-nodes-completed) would be invisible. Each test clears the hoisted mock
// immediately before the run so the assertion is precise. `source: 'bundled'`
// is threaded as the final arg to also confirm it reaches the telemetry payload.
// ───────────────────────────────────────────────────────────────────────────
describe('executeDagWorkflow -- completion telemetry', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-tel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockCaptureWorkflowCompleted.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  async function runDag(workflow: { name: string; nodes: DagNode[] }): Promise<void> {
    await executeDagWorkflow(
      createMockDeps(createMockStore()),
      createMockPlatform(),
      'conv-dag',
      testDir,
      workflow,
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      undefined,
      'bundled'
    );
  }

  it('emits outcome=completed with node counts and the threaded source on success', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield { type: 'result', sessionId: 'sid-ok' };
    });

    await runDag({ name: 'dag-ok', nodes: [{ id: 'step', prompt: 'Do thing.' }] });

    // Exactly once — guards against the double-count risk the PR flagged.
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'completed',
        workflowSource: 'bundled',
        nodesCompleted: 1,
        nodesTotal: 1,
      })
    );
    // No node reported usage — the fields must be OMITTED, not sent as zero.
    const captured = mockCaptureWorkflowCompleted.mock.calls[0][0] as Record<string, unknown>;
    expect('costUsd' in captured).toBe(false);
    expect('tokensIn' in captured).toBe(false);
    expect('tokensOut' in captured).toBe(false);
    expect('loopIterations' in captured).toBe(false);
  });

  it('threads provider-reported cost and tokens into the completion telemetry', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield {
        type: 'result',
        sessionId: 'sid-usage',
        cost: 0.25,
        tokens: { input: 5000, output: 1200 },
      };
    });

    await runDag({ name: 'dag-usage', nodes: [{ id: 'step', prompt: 'Do thing.' }] });

    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'completed',
        costUsd: 0.25,
        tokensIn: 5000,
        tokensOut: 1200,
      })
    );
  });

  it('ignores non-finite token values without poisoning the run totals', async () => {
    let call = 0;
    mockSendQueryDag.mockImplementation(function* () {
      call++;
      yield { type: 'assistant', content: `ok ${call}` };
      if (call === 1) {
        // Misbehaving provider: NaN tokens must be ignored (and warned), not summed.
        yield { type: 'result', sessionId: 'sid-bad', tokens: { input: NaN, output: 100 } };
      } else {
        yield { type: 'result', sessionId: 'sid-good', tokens: { input: 700, output: 50 } };
      }
    });

    await runDag({
      name: 'dag-nan',
      nodes: [
        { id: 'node1', prompt: 'First.' },
        { id: 'node2', prompt: 'Second.', depends_on: ['node1'] },
      ],
    });

    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', tokensIn: 700, tokensOut: 50 })
    );
  });

  it('emits outcome=failed exit_reason=no_nodes_completed when the only node fails', async () => {
    // A result chunk with no assistant text fails the node (see "produced no
    // assistant output" guard), leaving zero completed nodes.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'result', sessionId: 'sid-empty' };
    });

    await runDag({ name: 'dag-empty', nodes: [{ id: 'only', prompt: 'Do thing.' }] });

    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        workflowSource: 'bundled',
        exitReason: 'no_nodes_completed',
        // Failure taxonomy: "produced no assistant output" matches no fatal/
        // transient pattern → unknown; the failing node is a prompt node.
        errorClass: 'unknown',
        failedNodeType: 'prompt',
      })
    );
  });

  it('emits outcome=failed exit_reason=node_error when one node completes and another fails', async () => {
    // node2 depends on node1, so order is deterministic: node1 yields assistant
    // text (completes), node2 yields only a result (fails) → 1 completed, 1 failed.
    let call = 0;
    mockSendQueryDag.mockImplementation(function* () {
      call++;
      if (call === 1) {
        yield { type: 'assistant', content: 'first ok' };
        yield { type: 'result', sessionId: 'sid-1' };
      } else {
        yield { type: 'result', sessionId: 'sid-2' };
      }
    });

    await runDag({
      name: 'dag-partial',
      nodes: [
        { id: 'node1', prompt: 'First.' },
        { id: 'node2', prompt: 'Second.', depends_on: ['node1'] },
      ],
    });

    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        workflowSource: 'bundled',
        exitReason: 'node_error',
        errorClass: 'unknown',
        failedNodeType: 'prompt',
      })
    );
  });
});

describe('executeDagWorkflow -- loop_group node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-loopgroup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('completes a loop_group when the until signal appears on iteration N', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'assistant', content: 'iteration 1 work, not done yet' };
      } else {
        yield { type: 'assistant', content: 'iteration 2 final result\nDONE' };
      }
      yield { type: 'result', sessionId: `lg-sess-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-loopgroup-done');

    const nodes: DagNode[] = [
      {
        id: 'fixer',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work, emit DONE when finished', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'dag-loopgroup-done', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Two iterations: iter 1 (no signal) → iter 2 (DONE signal) → complete.
    expect(callCount).toBe(2);
    expect(result).toContain('iteration 2 final result');
  });

  it('fails the loop_group when max_iterations is exceeded without the until signal', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      yield { type: 'assistant', content: `iteration ${callCount} work, still going` };
      yield { type: 'result', sessionId: `lg-sess-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-loopgroup-maxiter');

    const nodes: DagNode[] = [
      {
        id: 'fixer',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work, never emit DONE', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'dag-loopgroup-maxiter', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Exhausted max_iterations (3) with no signal → run failed, no terminal output.
    expect(callCount).toBe(3);
    expect(result).toBeUndefined();
  });

  it('INSTANCE 1: multi-node body (implement→test→review) completes on iteration 2', async () => {
    // The body has 3 nodes; only `review` is AI (calls sendQuery). implement+test are
    // bash. On iteration 1 review does NOT emit DONE; on iteration 2 it does.
    let reviewCalls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      reviewCalls++;
      const content =
        reviewCalls === 1 ? 'tests still failing, need another pass' : 'all tests green now\nDONE';
      yield { type: 'assistant', content };
      yield { type: 'result', sessionId: `review-sess-${reviewCalls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-multinode');

    const nodes: DagNode[] = [
      {
        id: 'fix-loop',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            { id: 'implement', bash: 'echo "editing files"', depends_on: [] },
            { id: 'test', bash: 'echo "running tests"', depends_on: ['implement'] },
            {
              id: 'review',
              prompt: 'Review the test results. Emit DONE only when all tests pass.',
              depends_on: ['test'],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-multinode', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // 2 iterations (review called once per iteration); DONE on iteration 2.
    expect(reviewCalls).toBe(2);
    expect(result).toContain('all tests green now');
  });

  it('INSTANCE 2: $LOOP_PREV cross-iteration ref sees prior iteration output', async () => {
    // The body prompt references $LOOP_PREV.work.output. We assert the mock receives a
    // prompt that contains the PREVIOUS iteration's output on iteration 2+ (and empty
    // on iteration 1). Iteration 1 returns "iter-1-draft"; iteration 2's prompt must
    // contain "iter-1-draft" (carried via $LOOP_PREV), and iteration 2 emits DONE.
    let callCount = 0;
    const receivedPrompts: string[] = [];
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      callCount++;
      receivedPrompts.push(prompt ?? '');
      const content = callCount === 1 ? 'iter-1-draft' : 'iter-2-final\nDONE';
      yield { type: 'assistant', content };
      yield { type: 'result', sessionId: `s-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-loopprev');

    const nodes: DagNode[] = [
      {
        id: 'draft-loop',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              prompt: 'Previous draft:\n$LOOP_PREV.work.output\nImprove it. Emit DONE when final.',
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-loopprev', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Iteration 1 prompt: $LOOP_PREV resolved to '' (no prior iteration).
    expect(callCount).toBeGreaterThanOrEqual(1);
    // The first prompt must NOT carry the prior output (there is none).
    expect(receivedPrompts[0]).not.toContain('iter-1-draft');
    // Iteration 2 prompt MUST carry iteration 1's output via $LOOP_PREV.
    expect(callCount).toBe(2);
    expect(receivedPrompts[1]).toContain('iter-1-draft');
  });

  it('INSTANCE 3: until_bash deterministic gate completes on exit 0', async () => {
    // No `until` signal from AI; completion is decided solely by until_bash exit code.
    // The body is a pure bash node that increments a counter file each iteration;
    // until_bash exits 0 once the counter reaches 2. No AI node → sendQuery unused.
    const counterFile = join(testDir, 'iter-counter');
    // The path is interpolated into REAL bash scripts: on Windows, join() yields
    // backslashes that bash strips as escapes. Use forward slashes + quoting so
    // the script is valid on every platform (git-bash accepts D:/-style paths).
    const counterRef = `"${counterFile.replace(/\\/g, '/')}"`;

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-untilbash');

    const nodes: DagNode[] = [
      {
        id: 'bash-loop',
        loop_group: {
          until: 'NEVER_EMITTED', // rely on until_bash, not the signal
          max_iterations: 5,
          fresh_context: false,
          until_bash: `test "$(cat ${counterRef} 2>/dev/null || echo 0)" -ge 2`,
          nodes: [
            {
              id: 'bump',
              bash: `n=$(cat ${counterRef} 2>/dev/null || echo 0); echo $((n+1)) > ${counterRef}; echo "iter $((n+1))"`,
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-untilbash', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // until_bash exits 0 once the counter reaches 2 → completes after 2 iterations.
    // The counter file holds the final iteration count (2).
    const { readFile } = await import('fs/promises');
    const finalCount = parseInt((await readFile(counterFile, 'utf8')).trim(), 10);
    expect(finalCount).toBe(2);
    // The group's output is the terminal body node's (bump) last-iteration stdout.
    expect(result).toContain('iter 2');
  });

  it('INSTANCE 4: single-node body degenerates like loop: and completes in 1 iteration', async () => {
    // A loop_group with a single prompt node that emits DONE on the very first iteration.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: 'done immediately\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-single');

    const nodes: DagNode[] = [
      {
        id: 'once',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [{ id: 'only', prompt: 'do it, emit DONE', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-single', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Single iteration, completed immediately.
    expect(calls).toBe(1);
    expect(result).toContain('done immediately');
  });

  // --- Edge cases ---

  it('EDGE A: a failed body node fails the group immediately with the real error', async () => {
    // A body node failure must NOT silently re-run the body until max_iterations —
    // that burns AI cost per iteration and buries the root cause under a generic
    // max-iterations message (the exact anti-pattern executeLoopNode already fixed).
    // The group fails fast, surfacing the failed body node's own error.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      throw new Error('body node exploded');
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-body-fail');

    const nodes: DagNode[] = [
      {
        id: 'flaky',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-body-fail', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Fail-fast: exactly ONE iteration ran — no burn-to-max_iterations.
    expect(calls).toBe(1);
    // Run failed → no terminal output returned to the outer DAG.
    expect(result).toBeUndefined();
    // The user-facing failure surfaced the body node's real error, not a
    // generic max-iterations message.
    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain('body node exploded');
    expect(sent).not.toContain('exceeded max iterations');
  });

  it('EDGE B: body prompt can reference an outer-DAG upstream node via $nodeId.output', async () => {
    // The loop_group depends_on an outer bash node `setup`. The body prompt references
    // $setup.output. outerNodeOutputs is seeded into the scoped map, so the ref resolves.
    let receivedPrompt = '';
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      receivedPrompt = prompt ?? '';
      yield { type: 'assistant', content: 'saw setup output\nDONE' };
      yield { type: 'result', sessionId: 's' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-outer-dep');

    const nodes: DagNode[] = [
      { id: 'setup', bash: 'echo "setup-context-123"', depends_on: [] },
      {
        id: 'consumer',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              prompt: 'Outer setup said: $setup.output\nNow act on it. Emit DONE.',
              depends_on: [],
            },
          ],
        },
        depends_on: ['setup'],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-outer-dep', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The body prompt received the outer node's output (seeded into the scoped map).
    expect(receivedPrompt).toContain('setup-context-123');
    // Completed in 1 iteration (signal emitted immediately).
    expect(result).toContain('saw setup output');
  });

  it('EDGE F: $LOOP_PREV.<id>.output.<field> resolves structured prior-iteration output (unit)', () => {
    // Unit-level: substituteLoopPrevRefs field access against a structured NodeOutput.
    const prev = new Map<string, NodeOutput>([
      ['work', makeOutput('completed', '', { status: 'green', count: 7 }, ['status', 'count'])],
    ]);
    // Field access resolves from structuredOutput.
    expect(substituteLoopPrevRefs('status=$LOOP_PREV.work.output.status', prev)).toBe(
      'status=green'
    );
    expect(substituteLoopPrevRefs('count=$LOOP_PREV.work.output.count', prev)).toBe('count=7');
    // Whole-output form still works (returns the raw output string, here '').
    expect(substituteLoopPrevRefs('all=[$LOOP_PREV.work.output]', prev)).toBe('all=[]');
  });

  it('EDGE F: $LOOP_PREV.<id>.output.<field> on a missing prior node resolves to empty', () => {
    // The referenced node wasn't in the prior iteration (skipped/absent) → '' not a throw.
    const prev = new Map<string, NodeOutput>([['work', makeOutput('completed', 'ran', undefined)]]);
    expect(substituteLoopPrevRefs('other=[$LOOP_PREV.absent.output.field]', prev)).toBe('other=[]');
  });

  it('EDGE H: applyLoopPrevToBodyNode uses shell escaping only for shell-bound fields (unit)', () => {
    // Prior output contains a single quote — the acid test for escaping-mode mixups.
    const prev = new Map<string, NodeOutput>([
      ['work', makeOutput('completed', "it's done", undefined)],
    ]);

    // bash: shell-bound → value arrives shell-quoted.
    const bashNode = applyLoopPrevToBodyNode(
      { id: 'b', bash: 'echo $LOOP_PREV.work.output', depends_on: [] } as DagNode,
      prev,
      ''
    );
    expect('bash' in bashNode && bashNode.bash).toBe("echo 'it'\\''s done'");

    // script: runs via execFile argv (no shell) → raw value, no quote artifacts in source.
    const scriptNode = applyLoopPrevToBodyNode(
      {
        id: 's',
        script: 'console.log(`$LOOP_PREV.work.output`)',
        runtime: 'bun',
        depends_on: [],
      } as DagNode,
      prev,
      ''
    );
    expect('script' in scriptNode && scriptNode.script).toBe("console.log(`it's done`)");

    // cancel: display text → raw value.
    const cancelNode = applyLoopPrevToBodyNode(
      { id: 'c', cancel: 'stopping: $LOOP_PREV.work.output', depends_on: [] } as DagNode,
      prev,
      ''
    );
    expect('cancel' in cancelNode && cancelNode.cancel).toBe("stopping: it's done");
  });

  it('EDGE H: nested loop until_bash gets $LOOP_PREV substituted shell-safely (unit)', () => {
    const prev = new Map<string, NodeOutput>([
      ['work', makeOutput('completed', 'PASS', undefined)],
    ]);
    const nestedLoop = applyLoopPrevToBodyNode(
      {
        id: 'inner',
        loop: {
          prompt: 'iterate on $LOOP_PREV.work.output',
          until: 'DONE',
          max_iterations: 2,
          until_bash: 'test $LOOP_PREV.work.output = PASS',
        },
        depends_on: [],
      } as DagNode,
      prev,
      ''
    );
    if (!('loop' in nestedLoop) || nestedLoop.loop === undefined)
      throw new Error('expected loop node');
    expect(nestedLoop.loop.prompt).toBe('iterate on PASS');
    expect(nestedLoop.loop.until_bash).toBe("test 'PASS' = PASS");

    const nestedGroup = applyLoopPrevToBodyNode(
      {
        id: 'inner-grp',
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          until_bash: 'test $LOOP_PREV.work.output = PASS',
          nodes: [{ id: 'w', prompt: 'p', depends_on: [] }],
        },
        depends_on: [],
      } as DagNode,
      prev,
      ''
    );
    if (!('loop_group' in nestedGroup) || nestedGroup.loop_group === undefined)
      throw new Error('expected loop_group node');
    expect(nestedGroup.loop_group.until_bash).toBe("test 'PASS' = PASS");
  });

  it('EDGE D: multi-terminal body runs parallel terminals; signal on the selected terminal completes', async () => {
    // Body has two no-dependency AI nodes (a, b) — a parallel layer, both run each
    // iteration. The group's terminal output is the FIRST completed terminal node in
    // definition order (a before b), so the completion signal must appear in a's output
    // to be detected. This verifies (1) parallel terminals run concurrently and (2) the
    // terminal-output selection picks `a`.
    let aCalls = 0;
    let bCalls = 0;
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      // Distinguish the two body nodes by their prompt content.
      if (prompt.includes('node-a')) {
        aCalls++;
        yield { type: 'assistant', content: 'a-output DONE' };
      } else {
        bCalls++;
        yield { type: 'assistant', content: 'b-output (no signal)' };
      }
      yield { type: 'result', sessionId: 's' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-multiterminal');

    const nodes: DagNode[] = [
      {
        id: 'multi',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            { id: 'a', prompt: 'I am node-a. Emit DONE.', depends_on: [] },
            { id: 'b', prompt: 'I am node-b. Do work.', depends_on: [] },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-multiterminal', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Both parallel terminal nodes ran on the completing iteration (iter 1).
    expect(aCalls).toBeGreaterThanOrEqual(1);
    expect(bCalls).toBeGreaterThanOrEqual(1);
    // `a` (first terminal in def order) emitted DONE → group completed; its output is
    // the group's terminal output.
    expect(result).toContain('a-output');
  });

  it('EDGE C: fresh_context=true does not crash and the group still completes', async () => {
    // Smoke: fresh_context:true path. We can't easily assert session reset from the mock,
    // but we verify the group completes normally with fresh_context on.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: calls === 1 ? 'wip' : 'final\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-fresh');

    const nodes: DagNode[] = [
      {
        id: 'fresh',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: true,
          nodes: [{ id: 'work', prompt: 'do work', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-fresh', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(calls).toBe(2);
    expect(result).toContain('final');
  });

  it('EDGE E: between-iteration cancellation stops the loop with a failed result', async () => {
    // getWorkflowRunStatus returns 'running' on iteration 1, then 'cancelled' before
    // iteration 2 → the between-iteration check halts the loop with a failed result.
    let calls = 0;
    const statuses = ['running', 'cancelled', 'cancelled'];
    // Override the store mock to cycle statuses. createMockDeps uses createMockStore which
    // returns 'running' always; we override getWorkflowRunStatus here.
    const mockDeps = createMockDeps();
    (mockDeps.store.getWorkflowRunStatus as ReturnType<typeof mock>).mockImplementation(() => {
      const s = statuses[Math.min(calls, statuses.length - 1)];
      return Promise.resolve(s as 'running' | 'cancelled');
    });
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: `iter ${calls} work` };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-cancel');

    const nodes: DagNode[] = [
      {
        id: 'cancellable',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-cancel', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Only iteration 1 ran before cancellation halted the loop. The run did not complete
    // (no DONE) → outer DAG sees no terminal output.
    expect(calls).toBe(1);
    expect(result).toBeUndefined();
  });

  it('EDGE G: until signal OR until_bash — signal short-circuits until_bash (not executed)', async () => {
    // Both until and until_bash are set. The AI emits the until signal on iteration 1;
    // completionDetected = signalDetected (true) short-circuits before until_bash runs.
    // We prove until_bash was skipped via a sentinel file it would create if executed.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: 'done\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-or');
    const sentinel = join(testDir, 'untilbash-ran');

    const nodes: DagNode[] = [
      {
        id: 'either',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          // Creates a sentinel file + exits 0. If this runs, the file exists; if the
          // until-signal short-circuits, the file is never created.
          until_bash: `touch ${sentinel}`,
          nodes: [{ id: 'work', prompt: 'do work, emit DONE', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-or', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Signal completed on iteration 1.
    expect(calls).toBe(1);
    expect(result).toContain('done');
    // until_bash was short-circuited (sentinel file NOT created).
    let sentinelExists = true;
    try {
      await readFile(sentinel, 'utf8');
    } catch {
      sentinelExists = false;
    }
    expect(sentinelExists).toBe(false);
  });

  it('EDGE I: max_iterations=1 single-shot completes when signal present, fails otherwise', async () => {
    // Single iteration allowed. With the signal present → completes in 1.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: 'one-shot\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-single-shot');

    const nodes: DagNode[] = [
      {
        id: 'once',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work, emit DONE', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-single-shot', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(calls).toBe(1);
    expect(result).toContain('one-shot');
  });

  it('EDGE H: nested loop_group (loop_group inside a loop_group body) runs', async () => {
    // Outer body contains an inner loop_group. The inner group completes in 1 iteration
    // (emits INNER_DONE), and the outer completes when its terminal node emits OUTER_DONE.
    // This smoke-tests that applyLoopPrevToBodyNode recurses and that a body node which is
    // itself a loop_group dispatches correctly.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      // Inner loop_group's body node runs first (emits INNER_DONE → inner completes iter 1).
      // Then the outer's review node emits OUTER_DONE. Distinguish by call order.
      const content = calls === 1 ? 'inner work\nINNER_DONE' : 'outer review\nOUTER_DONE';
      yield { type: 'assistant', content };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-nested');

    const nodes: DagNode[] = [
      {
        id: 'outer',
        loop_group: {
          until: 'OUTER_DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'inner',
              loop_group: {
                until: 'INNER_DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  { id: 'inner-work', prompt: 'inner work, emit INNER_DONE', depends_on: [] },
                ],
              },
              depends_on: [],
            },
            {
              id: 'review',
              prompt: 'review inner result, emit OUTER_DONE',
              depends_on: ['inner'],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-nested', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Inner ran (1 call), then outer review ran (1 call) emitting OUTER_DONE → outer completes.
    expect(calls).toBe(2);
    expect(result).toContain('outer review');
  });

  // --- Dimension 4: interactive gate + resume ---

  it('INTERACTIVE: interactive loop_group pauses at the gate after iteration 1', async () => {
    // Fresh interactive loop_group: iteration 1 emits no signal → pauses at the gate.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'iteration 1 draft, awaiting review' };
      yield { type: 'result', sessionId: 'lg-gate-sess-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-interactive');

    const nodes: DagNode[] = [
      {
        id: 'refine',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          nodes: [{ id: 'work', prompt: 'produce a draft', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-interactive', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // One AI call (iteration 1), then paused.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const pauseCalls = (
      mockDeps.store.pauseWorkflowRun as Mock<
        (id: string, ctx: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
      completionSignaled: false,
      signaledOutput: null,
    });
    const pausedGroupMessage = (pauseCalls[0][1] as { message: string }).message;
    expect(pausedGroupMessage).toContain('No completion signal');
    expect(pausedGroupMessage).toContain('Review the result.');
  });

  it('INTERACTIVE: loop_group gate persists signal state when iteration 1 signals (#2074)', async () => {
    // Signal on iteration 1 of a fresh interactive loop_group (no signal_completes):
    // still gates, but the pause carries completionSignaled + signaledOutput so a
    // bare approve can finalize at resume.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'validation PASS\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-sig-sess-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-signal-gate');

    const nodes: DagNode[] = [
      {
        id: 'refine',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          nodes: [{ id: 'work', prompt: 'validate', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-signal-gate', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const pauseCalls = (
      mockDeps.store.pauseWorkflowRun as Mock<
        (id: string, ctx: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
      completionSignaled: true,
    });
    expect(String(pauseCalls[0][1].signaledOutput)).toContain('validation PASS');
    expect(String(pauseCalls[0][1].message)).toContain('Completion signal detected');
  });

  it('INTERACTIVE: loop_group signal_completes completes on a first-iteration signal without gating (#2074 B)', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'validation PASS\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-sc-sess-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-signal-completes');

    const nodes: DagNode[] = [
      {
        id: 'refine',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          signal_completes: true,
          nodes: [{ id: 'work', prompt: 'validate', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-signal-completes', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<() => Promise<void>>).mock.calls;
    expect(pauseCalls.length).toBe(0);
    const eventCalls = (
      mockDeps.store.createWorkflowEvent as Mock<
        (e: {
          event_type: string;
          step_name: string;
          data: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls;
    const completed = eventCalls.filter(
      c => c[0].event_type === 'node_completed' && c[0].step_name === 'refine'
    );
    expect(completed.length).toBe(1);
  });

  it('INTERACTIVE: loop_group finalizes at resume from persisted signaledOutput on a bare approve (#2074 C)', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-finalize', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'lg-sig-sess-1',
          sessionProvider: 'claude',
          message: 'gate',
          completionSignaled: true,
          signaledOutput: 'GROUP REPORT',
        },
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
    });

    const nodes: DagNode[] = [
      {
        id: 'refine',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          nodes: [{ id: 'work', prompt: 'validate', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-finalize', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // No body iteration ran — the group finalized from the persisted output.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    const eventCalls = (
      mockDeps.store.createWorkflowEvent as Mock<
        (e: {
          event_type: string;
          step_name: string;
          data: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls;
    const completed = eventCalls.filter(
      c => c[0].event_type === 'node_completed' && c[0].step_name === 'refine'
    );
    expect(completed.length).toBe(1);
    expect(completed[0][0].data.node_output).toBe('GROUP REPORT');
  });

  it('INTERACTIVE: resumed loop_group continues from the next iteration and completes', async () => {
    // Two-call pattern (mirrors the loop: resume test): call 1 pauses at the gate after
    // iteration 1 (no signal). Call 2 resumes with metadata.approval populated; iteration 2
    // emits APPROVED → completes.
    mockSendQueryDag.mockImplementationOnce(function* () {
      yield { type: 'assistant', content: 'iter1 draft, not approved' };
      yield { type: 'result', sessionId: 'lg-resume-sess-1' };
    });

    const mockDeps1 = createMockDeps();
    const platform1 = createMockPlatform();
    const freshRun = makeWorkflowRun('lg-resume-fresh');

    const workflow = {
      name: 'lg-resume',
      nodes: [
        {
          id: 'refine',
          loop_group: {
            until: 'APPROVED',
            max_iterations: 5,
            fresh_context: false,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              { id: 'work', prompt: 'User: $LOOP_USER_INPUT. Draft or APPROVED.', depends_on: [] },
            ],
          },
          depends_on: [],
        },
      ] as DagNode[],
    };

    await executeDagWorkflow(
      mockDeps1,
      platform1,
      'conv-lg',
      testDir,
      workflow,
      freshRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );
    // Call 1 paused at iteration 1, persisting the body's session cursor so a
    // fresh_context: false resume can continue the same conversation.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const pauseCalls1 = (
      mockDeps1.store.pauseWorkflowRun as Mock<
        (id: string, ctx: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(pauseCalls1.length).toBe(1);
    expect(pauseCalls1[0]?.[1]?.sessionId).toBe('lg-resume-sess-1');
    // The pause payload tags the session with its provider (#1992) so the resume
    // never threads it into a node that resolves to a different provider.
    expect(pauseCalls1[0]?.[1]?.sessionProvider).toBe('claude');

    // ---- Call 2: resume with metadata.approval carrying iter 1 + user input.
    mockSendQueryDag.mockImplementationOnce(function* () {
      yield { type: 'assistant', content: 'all good, shipping\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-resume-sess-2' };
    });
    const mockDeps2 = createMockDeps();
    const platform2 = createMockPlatform();
    const resumedRun = makeWorkflowRun('lg-resume-resume', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'lg-resume-sess-1',
          sessionProvider: 'claude',
          message: 'Review.',
        },
        loop_user_input: 'looks great',
      },
    });

    await executeDagWorkflow(
      mockDeps2,
      platform2,
      'conv-lg',
      testDir,
      workflow,
      resumedRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Resumed iteration (iteration 2) ran once more and completed via APPROVED.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // The resumed iteration's prompt carried the user input via $LOOP_USER_INPUT.
    const resumePrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(resumePrompt).toContain('looks great');
    // fresh_context: false — the resumed iteration continues the PRE-PAUSE session
    // (restored from ApprovalContext.sessionId), not a fresh one.
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('lg-resume-sess-1');
    // Resume completed (no second pause at the gate).
    const pauseCalls2 = (
      mockDeps2.store.pauseWorkflowRun as Mock<
        (id: string, ctx: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(pauseCalls2.length).toBe(0);
  });

  it('INTERACTIVE resume: $LOOP_PREV is NOT preserved across the pause/resume boundary (v1 known limitation)', async () => {
    // v1 behavior: on interactive resume, loopPrevOutputs resets to undefined (the prior
    // process's body-output snapshot is not persisted in ApprovalContext). So the resumed
    // iteration's $LOOP_PREV.<bodyNode>.output resolves to '' — NOT to the paused run's
    // iteration-1 output. This test locks the current behavior; persisting $LOOP_PREV
    // across resume is a tracked follow-up (CodeRabbit finding #5).
    mockSendQueryDag.mockImplementationOnce(function* () {
      yield { type: 'assistant', content: 'iter1 body output XYZ' };
      yield { type: 'result', sessionId: 'lg-prev-sess-1' };
    });

    const mockDeps1 = createMockDeps();
    const workflow = {
      name: 'lg-resume-prev',
      nodes: [
        {
          id: 'refine',
          loop_group: {
            until: 'APPROVED',
            max_iterations: 5,
            fresh_context: false,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              {
                id: 'work',
                prompt: 'PREV=<<$LOOP_PREV.work.output>> USER=$LOOP_USER_INPUT. Draft or APPROVED.',
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ] as DagNode[],
    };
    await executeDagWorkflow(
      mockDeps1,
      createMockPlatform(),
      'conv-lg',
      testDir,
      workflow,
      makeWorkflowRun('lg-prev-fresh'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Iteration 1 prompt: $LOOP_PREV resolved to '' (no prior iteration in this process).
    const iter1Prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(iter1Prompt).toContain('PREV=<<>>');

    // ---- Resume: iteration 2.
    mockSendQueryDag.mockImplementationOnce(function* () {
      yield { type: 'assistant', content: 'final\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-prev-sess-2' };
    });
    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-lg',
      testDir,
      workflow,
      makeWorkflowRun('lg-prev-resume', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'lg-prev-sess-1',
            message: 'Review.',
          },
          loop_user_input: 'ok',
        },
      }),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Resumed iteration 2: $LOOP_PREV is '' (v1 does not persist the prior body snapshot
    // across resume), NOT 'iter1 body output XYZ'.
    const resumePrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(resumePrompt).toContain('PREV=<<>>');
    expect(resumePrompt).not.toContain('iter1 body output XYZ');
    expect(resumePrompt).toContain('USER=ok');
  });

  // --- Dimension 3: cost/token accumulation across iterations ---

  it('COST: accumulates total_cost_usd across loop_group iterations', async () => {
    // 2 iterations: iter 1 no signal (cost 0.01), iter 2 DONE (cost 0.02).
    // The group sums per-iteration cost into its NodeExecutionResult; the outer runLayers
    // then aggregates it into the run's total_cost_usd.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      const cost = calls === 1 ? 0.01 : 0.02;
      const content = calls === 1 ? 'work in progress' : 'done\nDONE';
      yield { type: 'assistant', content };
      yield { type: 'result', sessionId: `s-${calls}`, cost };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-cost');

    const nodes: DagNode[] = [
      {
        id: 'paid',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-cost', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(calls).toBe(2);
    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    // 0.01 + 0.02 = 0.03 accumulated across the group's 2 iterations.
    expect(completeCalls[0][1]).toMatchObject({ total_cost_usd: 0.03 });
  });

  it('COST: accumulates token usage across loop_group iterations', async () => {
    mockCaptureWorkflowCompleted.mockClear();
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      const content = calls === 1 ? 'work in progress' : 'done\nDONE';
      yield { type: 'assistant', content };
      yield {
        type: 'result',
        sessionId: `s-${calls}`,
        tokens: calls === 1 ? { input: 100, output: 10 } : { input: 200, output: 20 },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-tokens');

    const nodes: DagNode[] = [
      {
        id: 'paid',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-tokens', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(calls).toBe(2);
    // The group sums tokens across iterations into its result; the outer runLayers
    // rolls them into the run totals reported via telemetry.
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', tokensIn: 300, tokensOut: 30 })
    );
  });

  it('SESSION: fresh_context=false threads the body session between iterations', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: calls >= 2 ? 'done\nDONE' : 'progress' };
      yield { type: 'result', sessionId: `lg-sess-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-session-thread');

    const nodes: DagNode[] = [
      {
        id: 'stateful',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-session-thread', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Iteration 1: always fresh.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // Iteration 2: resumes iteration 1's session (fresh_context: false).
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('lg-sess-1');
  });

  it('SESSION: fresh_context=true starts a fresh body session every iteration', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: calls >= 2 ? 'done\nDONE' : 'progress' };
      yield { type: 'result', sessionId: `lg-fresh-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-session-fresh');

    const nodes: DagNode[] = [
      {
        id: 'stateless',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: true,
          nodes: [{ id: 'work', prompt: 'do work', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-session-fresh', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
  });

  it('WHEN: a body node when: gates on a sibling output per iteration without leaking skip state', async () => {
    // Iteration 1: gate node outputs 'stop' → work is skipped (when false) → no
    // completed terminal output → no signal → iteration 2. Iteration 2: gate outputs
    // 'go' → work runs and emits DONE. Proves (1) when: evaluates against the SAME
    // iteration's scoped outputs and (2) skip state doesn't leak into iteration 2.
    let gateCalls = 0;
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      if (prompt.includes('GATE')) {
        gateCalls++;
        yield { type: 'assistant', content: gateCalls === 1 ? 'stop' : 'go' };
        yield { type: 'result', sessionId: `gate-${gateCalls}` };
      } else {
        yield { type: 'assistant', content: 'work ran\nDONE' };
        yield { type: 'result', sessionId: 'work-1' };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-when');

    const nodes: DagNode[] = [
      {
        id: 'gated',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: true,
          nodes: [
            { id: 'gate', prompt: 'GATE: decide', depends_on: [] },
            {
              id: 'work',
              prompt: 'do the work',
              depends_on: ['gate'],
              when: "$gate.output == 'go'",
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-when', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // gate ran twice (both iterations); work ran once (iteration 2 only).
    expect(gateCalls).toBe(2);
    expect(mockSendQueryDag.mock.calls.length).toBe(3);
    expect(result).toContain('work ran');
  });

  it('EDGE A2: a failed upstream body node skips its dependent and fails the group with the real error', async () => {
    // Multi-node body: implement fails → verify (depends_on implement) is skipped by
    // trigger-rule semantics → group fails fast with implement's error, one iteration.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      calls++;
      if (prompt.includes('IMPLEMENT')) {
        throw new Error('implement blew up');
      }
      yield { type: 'assistant', content: 'verified\nDONE' };
      yield { type: 'result', sessionId: 'v-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-multi-fail');

    const nodes: DagNode[] = [
      {
        id: 'pipeline',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            { id: 'implement', prompt: 'IMPLEMENT: fix it', depends_on: [] },
            { id: 'verify', prompt: 'verify the fix', depends_on: ['implement'] },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-multi-fail', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Only implement's single (failing) call ran — verify was skipped, no iteration 2.
    expect(calls).toBe(1);
    expect(result).toBeUndefined();
    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain('implement blew up');
    expect(sent).not.toContain('exceeded max iterations');
  });

  // --- Dimension 2: output_type typed artifact from final iteration ---

  it('OUTPUT_TYPE: loop_group with output_type writes a sidecar from the final terminal output', async () => {
    // The group declares output_type: 'result'. On completion, the outer runLayers writes
    // nodes/{groupId}.md from the group's NodeExecutionResult.output (= final iteration's
    // terminal output).
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      const content = calls === 1 ? 'draft v1' : 'final result v2\nDONE';
      yield { type: 'assistant', content };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-artifact');
    const artifactsDir = join(testDir, 'artifacts');

    const nodes: DagNode[] = [
      {
        id: 'producer',
        output_type: 'result',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'produce output', depends_on: [] }],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-artifact', nodes },
      workflowRun,
      'claude',
      undefined,
      artifactsDir,
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(calls).toBe(2);
    // The sidecar artifact carries the final iteration's terminal output.
    const written = await readFile(join(artifactsDir, 'nodes', 'producer.md'), 'utf8');
    expect(written).toContain('final result v2');
    expect(written).not.toContain('draft v1');
  });
});

// #2090: loop_group body lifecycle events must carry a namespaced persisted `step_name`
// (`<groupId>.<nodeId>`, composing across nested groups) plus the current `iteration`, while
// the in-process emitter payloads stay raw. Top-level DAG events are unchanged (bare id).
describe('executeDagWorkflow -- loop_group body step_name namespacing (#2090)', () => {
  let testDir: string;

  /** All persisted createWorkflowEvent payloads for a store mock. */
  type PersistedEvent = { event_type: string; step_name?: string; data?: Record<string, unknown> };
  const persistedEvents = (store: IWorkflowStore): PersistedEvent[] =>
    (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      c => c[0] as PersistedEvent
    );
  const eventsWith = (
    store: IWorkflowStore,
    eventType: string,
    stepName: string
  ): PersistedEvent[] =>
    persistedEvents(store).filter(e => e.event_type === eventType && e.step_name === stepName);

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-lg-ns-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('namespaces body node lifecycle step_name and tags iteration; top-level node stays bare', async () => {
    // `work` (AI) does not emit DONE on iteration 1, emits it on iteration 2 → 2 iterations.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield {
        type: 'assistant',
        content: calls === 1 ? 'still working' : 'finished\nDONE',
      };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-ns-run');

    const nodes: DagNode[] = [
      // Top-level bash node — its events must NOT be namespaced and must NOT carry iteration.
      { id: 'setup', bash: 'echo ready', depends_on: [] },
      {
        id: 'fixer',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work, emit DONE when done', depends_on: [] }],
        },
        depends_on: ['setup'],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-ns', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(calls).toBe(2);

    // Body node events are namespaced `<groupId>.<nodeId>`.
    const bodyStarted = eventsWith(store, 'node_started', 'fixer.work');
    const bodyCompleted = eventsWith(store, 'node_completed', 'fixer.work');
    expect(bodyStarted.length).toBe(2); // one per iteration
    expect(bodyCompleted.length).toBe(2);
    // Each body lifecycle event carries the iteration it ran in.
    expect(bodyStarted.map(e => e.data?.iteration).sort()).toEqual([1, 2]);
    expect(bodyCompleted.map(e => e.data?.iteration).sort()).toEqual([1, 2]);

    // The raw (un-namespaced) body id must NEVER appear as a persisted step_name.
    expect(persistedEvents(store).some(e => e.step_name === 'work')).toBe(false);

    // The group node's OWN events keep the bare group id (they are not body events).
    expect(eventsWith(store, 'node_completed', 'fixer').length).toBeGreaterThanOrEqual(1);
    expect(eventsWith(store, 'loop_iteration_started', 'fixer').length).toBe(2);

    // Top-level node keeps its bare id and carries no `iteration` tag.
    const setupStarted = eventsWith(store, 'node_started', 'setup');
    expect(setupStarted.length).toBe(1);
    expect(setupStarted[0].data?.iteration).toBeUndefined();
    expect(eventsWith(store, 'node_completed', 'setup').length).toBe(1);
  });

  it('composes the prefix across nested loop_groups (<outer>.<inner>.<leaf>)', async () => {
    // Inner group completes in 1 iteration (INNER_DONE); outer completes when review emits
    // OUTER_DONE. Mirrors the EDGE H harness above.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield {
        type: 'assistant',
        content: calls === 1 ? 'inner work\nINNER_DONE' : 'outer review\nOUTER_DONE',
      };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-nested-ns');

    const nodes: DagNode[] = [
      {
        id: 'outer',
        loop_group: {
          until: 'OUTER_DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'inner',
              loop_group: {
                until: 'INNER_DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [{ id: 'leaf', prompt: 'inner work, emit INNER_DONE', depends_on: [] }],
              },
              depends_on: [],
            },
            { id: 'review', prompt: 'review, emit OUTER_DONE', depends_on: ['inner'] },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-nested-ns', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(calls).toBe(2);

    // Deepest body node composes both enclosing group ids.
    expect(eventsWith(store, 'node_completed', 'outer.inner.leaf').length).toBeGreaterThanOrEqual(
      1
    );
    // The inner group's OWN events are namespaced by the outer group only.
    expect(
      eventsWith(store, 'loop_iteration_started', 'outer.inner').length
    ).toBeGreaterThanOrEqual(1);
    // The outer body's sibling AI node is namespaced by the outer group.
    expect(eventsWith(store, 'node_completed', 'outer.review').length).toBeGreaterThanOrEqual(1);
    // No un-namespaced leaf/review rows leak.
    expect(persistedEvents(store).some(e => e.step_name === 'leaf')).toBe(false);
    expect(persistedEvents(store).some(e => e.step_name === 'review')).toBe(false);
  });

  it('keeps the in-process emitter payload raw (unprefixed nodeId) for body events', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done\nDONE' };
      yield { type: 'result', sessionId: 's-1' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-emit-raw');

    const captured: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(e => {
      if (e.runId === workflowRun.id) captured.push(e);
    });

    try {
      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-lg',
        testDir,
        {
          name: 'lg-emit-raw',
          nodes: [
            {
              id: 'fixer',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: false,
                nodes: [{ id: 'work', prompt: 'do work, emit DONE', depends_on: [] }],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );
    } finally {
      unsubscribe();
    }

    // The live emitter carries the RAW body node id (consumers key off this) — never `fixer.work`.
    const bodyCompleted = captured.filter(
      e => e.type === 'node_completed' && 'nodeId' in e && e.nodeId === 'work'
    );
    expect(bodyCompleted.length).toBeGreaterThanOrEqual(1);
    expect(
      captured.some(e => 'nodeId' in e && (e as { nodeId?: string }).nodeId === 'fixer.work')
    ).toBe(false);
  });

  it('resume: a namespaced body key in priorCompletedNodes cannot skip a top-level node', async () => {
    // Simulate a resume where a prior run's loop_group completed: the map holds the group id
    // AND a namespaced body key. The group must be skipped as a unit (body does NOT re-run),
    // and the un-namespaced body key must NOT be mistaken for the still-pending top-level node.
    let calls = 0;
    mockSendQueryDag.mockImplementation(function* () {
      calls++;
      yield { type: 'assistant', content: 'finalize output' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-resume');

    const priorCompletedNodes = new Map<string, string>([
      ['fixer', 'group output from prior run'],
      ['fixer.work', 'body output from prior run'],
    ]);

    const nodes: DagNode[] = [
      {
        id: 'fixer',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [{ id: 'work', prompt: 'do work, emit DONE', depends_on: [] }],
        },
        depends_on: [],
      },
      { id: 'finalize', prompt: 'finalize using $fixer.output', depends_on: ['fixer'] },
    ];

    let finalizePrompt = '';
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      calls++;
      finalizePrompt = prompt;
      yield { type: 'assistant', content: 'finalize output' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-lg',
      testDir,
      { name: 'lg-resume', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    // Only `finalize` executes: the loop_group `fixer` was skipped as a unit (body never
    // re-ran), and the namespaced `fixer.work` key skipped nothing at the top level.
    expect(calls).toBe(1);
    // The skipped group's pre-populated output flows into the still-running downstream node.
    expect(finalizePrompt).toContain('group output from prior run');
    // The group was skipped via its own id, and finalize genuinely ran.
    expect(eventsWith(store, 'node_skipped_prior_success', 'fixer').length).toBe(1);
    expect(eventsWith(store, 'node_completed', 'finalize').length).toBe(1);
  });
});

describe('resolveBashPath -- platform-aware bash binary resolution (#1326)', () => {
  const originalEnv = process.env.ARCHON_BASH_PATH;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ARCHON_BASH_PATH;
    } else {
      process.env.ARCHON_BASH_PATH = originalEnv;
    }
  });

  it('returns the platform default when ARCHON_BASH_PATH is unset', () => {
    delete process.env.ARCHON_BASH_PATH;
    const result = git.resolveBashPath();
    if (process.platform === 'win32') {
      // Multi-candidate scan: first existing Git-Bash location, or the
      // canonical Program Files default when none exist.
      expect(result.endsWith('\\bash.exe')).toBe(true);
    } else {
      expect(result).toBe('bash');
    }
  });

  it('returns the ARCHON_BASH_PATH override when the path exists', () => {
    // process.execPath is the test runner binary — always exists, cross-platform.
    process.env.ARCHON_BASH_PATH = process.execPath;
    expect(git.resolveBashPath()).toBe(process.execPath);
  });

  it('throws with an actionable message when ARCHON_BASH_PATH points to a non-existent path', () => {
    process.env.ARCHON_BASH_PATH = '/definitely/does/not/exist/bash';
    expect(() => git.resolveBashPath()).toThrow(
      /ARCHON_BASH_PATH points to a path that does not exist/
    );
  });

  it('error message includes both the bad path and the Git Bash hint', () => {
    process.env.ARCHON_BASH_PATH = '/definitely/does/not/exist/bash';
    try {
      git.resolveBashPath();
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('/definitely/does/not/exist/bash');
      expect(msg).toContain('LOCALAPPDATA');
    }
  });
});

describe('executeDagWorkflow -- provider-boundary session threading (#1992)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-provbound-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  async function runWorkflow(
    conversationId: string,
    workflow: { name: string; nodes: DagNode[] },
    workflowRun: WorkflowRun
  ): Promise<WorkflowDeps> {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    await executeDagWorkflow(
      mockDeps,
      platform,
      conversationId,
      testDir,
      workflow,
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );
    return mockDeps;
  }

  async function runTwoNodeWorkflow(secondNode: DagNode): Promise<void> {
    await runWorkflow(
      'conv-prov-bound',
      {
        name: 'dag-provider-boundary',
        nodes: [{ id: 'a', prompt: 'First step' }, secondNode],
      },
      makeWorkflowRun('provider-boundary-run')
    );
  }

  it('sequential node on a DIFFERENT provider gets a fresh session (no cross-provider resume)', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'step done' };
      yield { type: 'result', sessionId: 'sess-a' };
    });

    await runTwoNodeWorkflow({
      id: 'b',
      prompt: 'Second step',
      depends_on: ['a'],
      provider: 'codex',
    });

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Node a (claude) ran fresh; node b (codex) must NOT inherit a's claude session id.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
  });

  it('sequential node on the SAME provider still threads the session', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'step done' };
      yield { type: 'result', sessionId: 'sess-a' };
    });

    await runTwoNodeWorkflow({ id: 'b', prompt: 'Second step', depends_on: ['a'] });

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('sess-a');
  });

  it('node after a loop node on a DIFFERENT provider gets a fresh session', async () => {
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      if (prompt.includes('Iterate')) {
        yield { type: 'assistant', content: 'all done <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-sess' };
      } else {
        yield { type: 'assistant', content: 'downstream done' };
        yield { type: 'result', sessionId: 'sess-after' };
      }
    });

    await runWorkflow(
      'conv-prov-bound-loop',
      {
        name: 'dag-provider-boundary-loop',
        nodes: [
          {
            id: 'work',
            loop: { prompt: 'Iterate until done.', until: 'COMPLETE', max_iterations: 3 },
          },
          { id: 'after', prompt: 'Summarize', depends_on: ['work'], provider: 'codex' },
        ],
      },
      makeWorkflowRun('provider-boundary-loop-run')
    );

    // 1 loop iteration + 1 downstream call.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Downstream codex node must NOT resume the loop's claude session.
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
  });

  it('node after a loop node on the SAME provider still threads the loop session', async () => {
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      if (prompt.includes('Iterate')) {
        yield { type: 'assistant', content: 'all done <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-sess' };
      } else {
        yield { type: 'assistant', content: 'downstream done' };
        yield { type: 'result', sessionId: 'sess-after' };
      }
    });

    await runWorkflow(
      'conv-same-prov-loop',
      {
        name: 'dag-same-provider-loop',
        nodes: [
          {
            id: 'work',
            loop: { prompt: 'Iterate until done.', until: 'COMPLETE', max_iterations: 3 },
          },
          { id: 'after', prompt: 'Summarize', depends_on: ['work'] },
        ],
      },
      makeWorkflowRun('same-provider-loop-run')
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('loop-sess');
  });

  it('loop_group body: provider boundaries stay fresh within and across iterations', async () => {
    // Body: x (claude) -> y (codex), fresh_context: false. y emits DONE on iteration 2.
    // No call may ever receive a resume id: x->y is a provider boundary within the
    // iteration, and each cross-iteration handoff (y's codex cursor into x, x's claude
    // cursor into y) is a provider boundary too.
    let yCalls = 0;
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      if (prompt.includes('analyze')) {
        yield { type: 'assistant', content: 'analysis output' };
        yield { type: 'result', sessionId: 'sess-x' };
      } else {
        yCalls++;
        const content = yCalls === 1 ? 'not finished yet' : 'finished\nDONE';
        yield { type: 'assistant', content };
        yield { type: 'result', sessionId: `sess-y-${yCalls}` };
      }
    });

    await runWorkflow(
      'conv-lg-prov',
      {
        name: 'lg-provider-boundary',
        nodes: [
          {
            id: 'fixer',
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              fresh_context: false,
              nodes: [
                { id: 'x', prompt: 'analyze the failure', depends_on: [] },
                {
                  id: 'y',
                  prompt: 'apply the fix, emit DONE when green',
                  depends_on: ['x'],
                  provider: 'codex',
                },
              ],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-provider-boundary')
    );

    // 2 iterations x 2 body nodes = 4 calls, every one fresh.
    expect(mockSendQueryDag.mock.calls.length).toBe(4);
    for (const call of mockSendQueryDag.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
  });

  it('loop_group body: same-provider chain still threads within and across iterations', async () => {
    // Body: x -> y, both claude, fresh_context: false. Threading expectations:
    // iter1: x fresh, y resumes x's session; iter2 seeds y's iter-1 session into x,
    // then y resumes x's iter-2 session.
    let yCalls = 0;
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      if (prompt.includes('analyze')) {
        yield { type: 'assistant', content: 'analysis output' };
        yield { type: 'result', sessionId: `sess-x-${String(yCalls + 1)}` };
      } else {
        yCalls++;
        const content = yCalls === 1 ? 'not finished yet' : 'finished\nDONE';
        yield { type: 'assistant', content };
        yield { type: 'result', sessionId: `sess-y-${yCalls}` };
      }
    });

    await runWorkflow(
      'conv-lg-same',
      {
        name: 'lg-same-provider',
        nodes: [
          {
            id: 'fixer',
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              fresh_context: false,
              nodes: [
                { id: 'x', prompt: 'analyze the failure', depends_on: [] },
                { id: 'y', prompt: 'apply the fix, emit DONE when green', depends_on: ['x'] },
              ],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-same-provider')
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(4);
    const resumeIds = mockSendQueryDag.mock.calls.map(call => call[2]);
    // iter1: x fresh, y resumes x. iter2: x resumes y's iter-1 session, y resumes x's.
    expect(resumeIds[0]).toBeUndefined();
    expect(resumeIds[1]).toBe('sess-x-1');
    expect(resumeIds[2]).toBe('sess-y-1');
    expect(resumeIds[3]).toBe('sess-x-2');
  });

  it('interactive loop_group resume without a provider tag (legacy pause) restores fresh', async () => {
    // A run paused BEFORE the provider tag existed has approval metadata with a bare
    // sessionId. Restoring it untagged could thread the session into a different
    // provider, so the resume starts fresh instead (safe degradation).
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'resumed and finished\nDONE' };
      yield { type: 'result', sessionId: 'legacy-resume-sess' };
    });

    await runWorkflow(
      'conv-lg-legacy',
      {
        name: 'lg-legacy-resume',
        nodes: [
          {
            id: 'refine',
            loop_group: {
              until: 'DONE',
              max_iterations: 5,
              fresh_context: false,
              interactive: true,
              gate_message: 'Review.',
              nodes: [{ id: 'work', prompt: 'Refine the draft.', depends_on: [] }],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-legacy-resume', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'pre-tag-sess-1', // no sessionProvider — legacy pause
            message: 'Review.',
          },
          loop_user_input: 'continue',
        },
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The untagged pre-pause session is NOT restored.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
  });

  it('interactive loop_group gate with no live cursor pauses with EXPLICIT null session fields', async () => {
    // Body tail is a PARALLEL layer (two sibling nodes, nothing downstream), which
    // resets the sequential cursor before the gate. The pause payload must write
    // sessionId/sessionProvider as explicit nulls — key omission would let SQLite's
    // json_patch deep-merge keep a stale pair from a previous pause of this run
    // (same convention as ApprovalContext.resolved).
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'checked, not done yet' };
      yield { type: 'result', sessionId: 'parallel-tail-sess' };
    });

    const mockDeps = await runWorkflow(
      'conv-lg-nullpause',
      {
        name: 'lg-null-pause',
        nodes: [
          {
            id: 'refine',
            loop_group: {
              until: 'DONE',
              max_iterations: 5,
              fresh_context: false,
              interactive: true,
              gate_message: 'Review.',
              nodes: [
                { id: 'lint', prompt: 'run lint checks', depends_on: [] },
                { id: 'test', prompt: 'run test checks', depends_on: [] },
              ],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-null-pause')
    );

    const pauseCalls = (
      mockDeps.store.pauseWorkflowRun as Mock<
        (id: string, ctx: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    const pauseCtx = pauseCalls[0][1];
    // Keys present with explicit null — NOT omitted, NOT a live session pair.
    expect('sessionId' in pauseCtx).toBe(true);
    expect('sessionProvider' in pauseCtx).toBe(true);
    expect(pauseCtx.sessionId).toBeNull();
    expect(pauseCtx.sessionProvider).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Include expansion — the "zero new runtime machinery" proof.
//
// Expand a parent that `include:`s a child (via expandWorkflowIncludes, exactly
// as discovery does), then run the flattened definition through executeDagWorkflow.
// The executor never sees an include node; the namespaced nodes behave as ordinary
// top-level nodes for events, terminal-output selection, resume-skip, and always_run.
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- include expansion (zero runtime machinery)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-include-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function buildWf(name: string, nodes: unknown[]): WorkflowDefinition {
    return { name, description: name, nodes: nodes.map(n => dagNodeSchema.parse(n)) };
  }

  /**
   * Parent that includes a 2-node bash child (a -> b) and reads `$inc.output`.
   * Expands to: inc__a -> inc__b -> consumer(reads $inc__b.output). `alwaysRunA`
   * flags the child's entry node so resume re-executes it.
   */
  function expandedParentNodes(alwaysRunA = false): DagNode[] {
    const child = buildWf('inc-child', [
      { id: 'a', bash: 'echo AAA', ...(alwaysRunA ? { always_run: true } : {}) },
      { id: 'b', bash: 'echo BBB', depends_on: ['a'] },
    ]);
    const parent = buildWf('inc-parent', [
      { id: 'inc', include: 'inc-child' },
      { id: 'consumer', bash: 'echo $inc.output', depends_on: ['inc'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['inc-child', child],
        ['inc-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...workflows.get('inc-parent')!.nodes];
  }

  function eventList(deps: WorkflowDeps): Array<{ event_type: string; step_name: string }> {
    return (deps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as { event_type: string; step_name: string }
    );
  }

  it('emits namespaced step_names and resolves $inc.output to the child terminal node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-run-id', { workflow_name: 'inc-parent' });

    const terminalOutput = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-inc',
      testDir,
      { name: 'inc-parent', nodes: expandedParentNodes() },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const events = eventList(mockDeps);
    const completedStepNames = events
      .filter(e => e.event_type === 'node_completed')
      .map(e => e.step_name);
    // Included nodes surface as ordinary namespaced top-level nodes in the event log.
    expect(completedStepNames).toContain('inc__a');
    expect(completedStepNames).toContain('inc__b');
    expect(completedStepNames).toContain('consumer');
    // No include node ever reached the executor.
    expect(events.every(e => e.step_name !== 'inc')).toBe(true);

    // $inc.output was rewritten to the child terminal ($inc__b.output = "BBB"), so the
    // run's terminal output (consumer, the sole sink) carries it.
    expect(terminalOutput).toContain('BBB');
  });

  it('resume skips a completed namespaced node and re-runs the rest', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-resume-id', { workflow_name: 'inc-parent' });

    // Prior run completed the namespaced entry node inc__a.
    const prior = new Map<string, string>([['inc__a', 'AAA']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-inc',
      testDir,
      { name: 'inc-parent', nodes: expandedParentNodes() },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      prior
    );

    const events = eventList(mockDeps);
    // inc__a skipped as prior-success (its namespaced id matched the persisted map).
    expect(
      events.some(e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__a')
    ).toBe(true);
    // Downstream namespaced node + consumer still executed.
    const completed = events.filter(e => e.event_type === 'node_completed').map(e => e.step_name);
    expect(completed).toContain('inc__b');
    expect(completed).toContain('consumer');
    expect(completed).not.toContain('inc__a');
  });

  it('always_run on an included node re-executes it on resume', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-always-id', { workflow_name: 'inc-parent' });

    const prior = new Map<string, string>([['inc__a', 'AAA']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-inc',
      testDir,
      { name: 'inc-parent', nodes: expandedParentNodes(true) },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      prior
    );

    const events = eventList(mockDeps);
    // always_run survived inlining: inc__a is force-reset (re-executed), not skipped.
    expect(
      events.some(e => e.event_type === 'node_always_run_reset' && e.step_name === 'inc__a')
    ).toBe(true);
    expect(
      events.some(e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__a')
    ).toBe(false);
    expect(events.some(e => e.event_type === 'node_completed' && e.step_name === 'inc__a')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// An unexpanded include node must FAIL LOUDLY, never silently skip — the
// fail-fast guard runs before resume-skip / when / trigger-rule handling.
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- unexpanded include node fail-fast guard', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-inc-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function events(
    deps: WorkflowDeps
  ): Array<{ event_type: string; step_name: string; data: unknown }> {
    return (deps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as { event_type: string; step_name: string; data: unknown }
    );
  }

  it('fails (not skips) an unexpanded include node that matches a prior-completed entry', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-guard-resume', { workflow_name: 'inc-guard' });

    // A raw include node reaching the executor with a resume entry for its own id: the
    // guard must fire BEFORE the resume-skip check, so it fails instead of being skipped.
    const includeNode = dagNodeSchema.parse({ id: 'inc', include: 'some-block' });
    const prior = new Map<string, string>([['inc', 'stale prior output']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-inc-guard',
      testDir,
      { name: 'inc-guard', nodes: [includeNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      prior
    );

    const evs = events(mockDeps);
    const failed = evs.find(e => e.event_type === 'node_failed' && e.step_name === 'inc');
    expect(failed).toBeDefined();
    expect((failed!.data as { error: string }).error).toContain('reached the executor unexpanded');
    // Crucially, it was NOT silently skipped as a prior success.
    expect(evs.some(e => e.event_type === 'node_skipped_prior_success')).toBe(false);
  });

  it('fails (not skips) an unexpanded include node whose when: would evaluate false', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-guard-when', { workflow_name: 'inc-guard' });

    // `flag` emits NO; the include's when checks == YES (false → would normally skip). The
    // guard must fire first and fail the node instead.
    const nodes = [
      dagNodeSchema.parse({ id: 'flag', bash: 'echo NO' }),
      dagNodeSchema.parse({
        id: 'inc',
        include: 'some-block',
        depends_on: ['flag'],
        when: "$flag.output == 'YES'",
      }),
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-inc-guard',
      testDir,
      { name: 'inc-guard', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const evs = events(mockDeps);
    const failed = evs.find(e => e.event_type === 'node_failed' && e.step_name === 'inc');
    expect(failed).toBeDefined();
    expect((failed!.data as { error: string }).error).toContain('reached the executor unexpanded');
    // It was NOT skipped via the when: gate.
    expect(evs.some(e => e.event_type === 'node_skipped' && e.step_name === 'inc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// An approval node inside an included block: pause + capture_response + no
// cross-talk when the same block is included twice.
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- approval node inside an included block', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-inc-approval-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function buildWf(name: string, nodes: unknown[]): WorkflowDefinition {
    return { name, description: name, nodes: nodes.map(n => dagNodeSchema.parse(n)) };
  }

  it('pauses at the namespaced approval id and exposes capture_response via it', async () => {
    const block = buildWf('apblk', [
      { id: 'approve', approval: { message: 'Approve this?', capture_response: true } },
    ]);
    const parent = buildWf('apparent', [
      { id: 'setup', bash: 'echo setup' },
      { id: 'rev', include: 'apblk', depends_on: ['setup'] },
      // Reads the include's output; the block's sole sink is the approval node, so
      // $rev.output resolves to the captured response via the namespaced id.
      { id: 'after', bash: 'echo $rev.output', depends_on: ['rev'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['apblk', block],
        ['apparent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('apparent')!;

    // capture_response (stored as $<approvalId>.output) is reachable via the namespaced id.
    const after = expanded.nodes.find(n => n.id === 'after');
    expect(after && 'bash' in after ? after.bash : '').toBe('echo $rev__approve.output');

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-approval-run', { workflow_name: 'apparent' });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-inc-approval',
      testDir,
      { name: 'apparent', nodes: expanded.nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    // The gate pauses under the namespaced approval id, not the bare block id.
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'rev__approve',
      message: 'Approve this?',
      captureResponse: true,
    });
  });

  it('the same approval block included twice yields distinct namespaced approval ids', () => {
    const block = buildWf('apblk', [{ id: 'approve', approval: { message: 'Approve?' } }]);
    const parent = buildWf('apparent', [
      { id: 'a', include: 'apblk' },
      { id: 'b', include: 'apblk', depends_on: ['a'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['apblk', block],
        ['apparent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const ids = workflows.get('apparent')!.nodes.map(n => n.id);
    // Distinct ApprovalContext.nodeId per inclusion → no cross-talk between the two gates.
    expect(ids).toContain('a__approve');
    expect(ids).toContain('b__approve');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('containerCommandName', () => {
  it('returns a bare command unchanged', () => {
    expect(containerCommandName('bash')).toBe('bash');
    expect(containerCommandName('bun')).toBe('bun');
  });

  it('strips a unix directory to the basename', () => {
    expect(containerCommandName('/usr/local/bin/bash')).toBe('bash');
  });

  it('strips a Windows path + .exe (container is always Linux)', () => {
    expect(containerCommandName('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash');
  });
});

describe('collectContainerIncompatibleProviders', () => {
  const promptNode = (id: string, provider?: string): DagNode =>
    ({ id, prompt: `do ${id}`, ...(provider ? { provider } : {}) }) as unknown as DagNode;
  const bashNode = (id: string): DagNode => ({ id, bash: 'echo hi' }) as unknown as DagNode;

  it('is empty when all AI nodes resolve to claude (containerExec: true)', () => {
    const nodes = [promptNode('a'), promptNode('b', 'claude'), bashNode('c')];
    const bad = collectContainerIncompatibleProviders(nodes, 'claude');
    expect([...bad]).toEqual([]);
  });

  it('flags a node whose provider lacks containerExec (codex)', () => {
    const nodes = [promptNode('a'), promptNode('b', 'codex')];
    const bad = collectContainerIncompatibleProviders(nodes, 'claude');
    expect([...bad]).toEqual(['codex']);
  });

  it('flags the workflow-level provider when a node does not override it', () => {
    const nodes = [promptNode('a')];
    const bad = collectContainerIncompatibleProviders(nodes, 'codex');
    expect([...bad]).toEqual(['codex']);
  });

  it('ignores bash/script nodes (deterministic, no provider)', () => {
    const nodes = [bashNode('a'), bashNode('b')];
    const bad = collectContainerIncompatibleProviders(nodes, 'codex');
    expect([...bad]).toEqual([]);
  });

  it('recurses loop_group bodies', () => {
    const group = {
      id: 'g',
      loop_group: { max_iterations: 2, nodes: [promptNode('inner', 'codex')] },
    } as unknown as DagNode;
    const bad = collectContainerIncompatibleProviders([group], 'claude');
    expect([...bad]).toEqual(['codex']);
  });
});

describe('buildSubprocessDockerArgs — bash/script env isolation', () => {
  const CTX = { kind: 'container' as const, containerId: 'cid-9' };

  it('delivers the Archon-managed env via -e flags only and runs at the same cwd', () => {
    const args = buildSubprocessDockerArgs(CTX, 'bash', ['-c', 'echo hi'], {
      cwd: '/tmp/ops-client',
      env: { ARTIFACTS_DIR: '/a', ANTHROPIC_API_KEY: 'sk', BASE_BRANCH: 'main' },
    });
    expect(args.slice(0, 2)).toEqual(['exec', '-w']);
    expect(args[2]).toBe('/tmp/ops-client');
    // Every managed var is delivered as an explicit -e flag.
    expect(args).toContain('-e');
    expect(args).toContain('ARTIFACTS_DIR=/a');
    expect(args).toContain('ANTHROPIC_API_KEY=sk');
    expect(args).toContain('BASE_BRANCH=main');
    // Container id, then the normalized command, then the node args.
    const cidIdx = args.indexOf('cid-9');
    expect(cidIdx).toBeGreaterThan(-1);
    expect(args[cidIdx + 1]).toBe('bash');
    expect(args.slice(cidIdx + 2)).toEqual(['-c', 'echo hi']);
  });

  it('does NOT leak host process.env (only the passed env bag is forwarded)', () => {
    const canary = 'ARCHON_DAGEXEC_CANARY';
    process.env[canary] = 'leaked';
    try {
      const args = buildSubprocessDockerArgs(CTX, 'bash', ['-c', 'true'], {
        cwd: '/w',
        env: { ONLY_THIS: '1' },
      });
      const joined = args.join(' ');
      expect(joined).toContain('ONLY_THIS=1');
      expect(joined).not.toContain(canary);
    } finally {
      delete process.env[canary];
    }
  });

  it('normalizes a host bash path to the in-container binary name', () => {
    const args = buildSubprocessDockerArgs(CTX, '/usr/local/bin/bash', ['-c', 'x'], {
      cwd: '/w',
      env: {},
    });
    const cidIdx = args.indexOf('cid-9');
    expect(args[cidIdx + 1]).toBe('bash');
  });

  it('never forwards denylisted keys (PATH/HOME) — a project env var must not clobber resolution', () => {
    const args = buildSubprocessDockerArgs(CTX, 'bash', ['-c', 'true'], {
      cwd: '/w',
      env: { PATH: '/evil/bin', HOME: '/evil', PWD: '/x', KEEP: '1' },
    });
    const joined = args.join(' ');
    expect(joined).not.toContain('PATH=/evil/bin');
    expect(joined).not.toContain('HOME=/evil');
    expect(joined).not.toContain('PWD=/x');
    expect(joined).toContain('KEEP=1'); // non-denylisted keys still forwarded
  });
});

// ---------------------------------------------------------------------------
// Container write-back gate + suspend-on-pause (Phase C)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- container write-back gate', () => {
  const CONTAINER_EXEC = { kind: 'container' as const, containerId: 'cid-1' };
  const wbTestDir = join(tmpdir(), `dag-wb-test-${Date.now()}`);

  function makeWritebackBackend(over?: Partial<Record<string, unknown>>) {
    return {
      suspend: mock(async () => undefined),
      finalize: mock(async () => ({ requiresApproval: false as boolean })),
      applyChanges: mock(async () => ({
        filesApplied: 0,
        filesDeleted: 0,
        warnings: [] as string[],
      })),
      discardChanges: mock(async () => undefined),
      ...over,
    };
  }

  /** Run a single pre-completed bash node under a container context so the gate runs. */
  async function runGate(opts: {
    backend: ReturnType<typeof makeWritebackBackend>;
    writeBack?: 'approve' | 'auto';
    runMetadata?: Record<string, unknown>;
    status?: 'running' | 'paused';
  }): Promise<IWorkflowStore> {
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve(opts.status ?? ('running' as const)));
    store.getWorkflowRun = mock(() =>
      Promise.resolve(makeWorkflowRun('wb-run', { metadata: opts.runMetadata ?? {} }))
    );
    const deps = createMockDeps(store);
    await executeDagWorkflow(
      deps,
      createMockPlatform(),
      'conv-wb',
      wbTestDir,
      { name: 'wb', nodes: [{ id: 'a', bash: 'echo hi' }] },
      makeWorkflowRun('wb-run'),
      'claude',
      undefined,
      join(wbTestDir, 'artifacts'),
      join(wbTestDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      new Map([['a', 'out']]), // pre-completed → node skipped, DAG reaches the gate
      undefined,
      undefined,
      undefined,
      undefined,
      CONTAINER_EXEC,
      { envId: 'env-x', writeBack: opts.writeBack ?? 'approve', backend: opts.backend }
    );
    return store;
  }

  it('empty diff → completes normally, no pause', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({ requiresApproval: false })),
    });
    const store = await runGate({ backend });
    expect(backend.finalize).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(backend.suspend).not.toHaveBeenCalled();
  });

  it('non-empty diff + approve policy → pauses (writeback) + suspends, does NOT complete', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          totalCount: 1,
          truncated: false,
        },
      })),
    });
    const store = await runGate({ backend });
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    const pauseArg = (store.pauseWorkflowRun as ReturnType<typeof mock>).mock.calls[0][1] as {
      nodeId: string;
      type: string;
    };
    expect(pauseArg.nodeId).toBe('__writeback__');
    expect(pauseArg.type).toBe('writeback');
    expect(store.updateWorkflowRun).toHaveBeenCalled(); // persists pending_writeback
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('non-empty diff + auto policy → applies without pausing, then completes', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          totalCount: 1,
          truncated: false,
        },
      })),
      applyChanges: mock(async () => ({ filesApplied: 1, filesDeleted: 0, warnings: [] })),
    });
    const store = await runGate({ backend, writeBack: 'auto' });
    expect(backend.applyChanges).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('resume after approve → applies overlay, marks resolved, completes', async () => {
    const backend = makeWritebackBackend({
      applyChanges: mock(async () => ({ filesApplied: 3, filesDeleted: 1, warnings: [] })),
    });
    const store = await runGate({
      backend,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval_response: 'approved' },
    });
    expect(backend.applyChanges).toHaveBeenCalledTimes(1);
    expect(backend.finalize).not.toHaveBeenCalled(); // resume path skips re-inspection
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('resume after reject → discards overlay (live root untouched), completes', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval_response: 'rejected' },
    });
    expect(backend.discardChanges).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('mid-DAG pause suspends the container instead of completing', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({ backend, status: 'paused' });
    // A node paused the run → suspend fires right after the layer walk; the gate
    // + completion are never reached.
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(backend.finalize).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });
});
