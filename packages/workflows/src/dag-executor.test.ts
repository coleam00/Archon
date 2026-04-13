import { describe, it, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
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
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));

// --- Bootstrap provider registry (after path mocks, before dag-executor import) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Imports (after mocks) ---
import {
  buildTopologicalLayers,
  checkTriggerRule,
  substituteNodeOutputRefs,
  executeDagWorkflow,
} from './dag-executor';
import { loadMcpConfig } from '@archon/providers/claude/provider';
import type { DagNode, BashNode, ScriptNode, NodeOutput, WorkflowRun } from './schemas';
import { discoverWorkflows } from './workflow-discovery';
import { parseWorkflow } from './loader';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';

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
  };
}

/** All-true capabilities for Claude mock */
const mockClaudeCapabilities = () => ({
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  toolRestrictions: true,
  structuredOutput: true,
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
  mcp: false,
  hooks: false,
  skills: false,
  toolRestrictions: false,
  structuredOutput: true,
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

function makeOutput(state: NodeOutput['state'], output = ''): NodeOutput {
  if (state === 'failed') return { state, output, error: 'error' };
  return { state, output } as NodeOutput;
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

  it('dot notation on invalid JSON returns empty string', () => {
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(substituteNodeOutputRefs('$a.output.field', outputs)).toBe('');
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

  it('object JSON field becomes quoted empty string when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ nested: { x: 1 } }))]]);
    expect(substituteNodeOutputRefs('echo $a.output.nested', outputs, true)).toBe("echo ''");
  });

  it('dot notation on invalid JSON returns quoted empty string when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(substituteNodeOutputRefs('$a.output.field', outputs, true)).toBe("''");
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
    // The mock platform should have received a failure message about no successful nodes
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('no successful nodes'));
    expect(failMsg).toBeDefined();
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
      'bash',
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

  it('warns user when Codex DAG node has skills and does not pass agents', async () => {
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

    // Warning sent to user
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('skills') && m.includes('codex'));
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
        message: 'Review the plan and provide feedback.',
      });
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
      });
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

  it('returns undefined when the single terminal node produces no output', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      // No assistant content — empty output
      yield { type: 'result', sessionId: 'sess-empty' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await executeDagWorkflow(
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

    expect(result).toBeUndefined();
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
    const failMsg = messages.find((m: string) => m.includes('no successful nodes'));
    expect(failMsg).toBeDefined();
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
    const failMsg = messages.find((m: string) => m.includes('no successful nodes'));
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
