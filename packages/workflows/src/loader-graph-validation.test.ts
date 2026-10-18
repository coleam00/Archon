// @archon-test-isolated
// The harness mocks @archon/paths so discovery never reads the real home or bundled workflows.
import './dag/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { providerRegistry } from '@archon/providers';
import { removeTempTree } from '@archon/paths/test-utils';
import type { AgentNode, DagNode } from './schemas';
import { discoverWorkflows } from './workflow-discovery';
import { parseWorkflow } from './loader';

describe('DAG Loader -- cycle detection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0].workflow;
    expect(wf.nodes).toHaveLength(4);
    expect(wf.nodes[0].id).toBe('classify');
    expect((wf.nodes[0] as DagNode).output_format).toBeDefined();
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0].workflow;
    expect(wf.nodes).toBeDefined();
    const stepA = wf.nodes[0] as AgentNode;
    expect(stepA.source).toEqual({ kind: 'inline', prompt: 'Output exactly: hello from A' });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
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

    const result = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.errors).toHaveLength(0);
    const wf = result.workflows
      .map(ws => ws.workflow)
      .find(w => w.name === 'tool-restriction-test');
    expect(wf).toBeDefined();
    if (!wf) return;
    const toolNodes = wf.nodes as AgentNode[];

    expect(toolNodes[0].allowed_tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(toolNodes[0].denied_tools).toBeUndefined();

    expect(toolNodes[1].denied_tools).toEqual(['WebSearch', 'WebFetch']);
    expect(toolNodes[1].allowed_tools).toBeUndefined();

    // Empty array must be preserved (distinct from absent)
    expect(toolNodes[2].allowed_tools).toEqual([]);
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
    const result = parseWorkflow(yaml, 'test.yaml', providerRegistry);
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    expect((wf.nodes[0] as DagNode).skills).toEqual(['codebase-search', 'test-runner']);
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
    const result = parseWorkflow(yaml, 'bad.yaml', providerRegistry);
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('skills');
  });

  it('accepts empty skills array', () => {
    const yaml = `
name: empty-skills
description: test
nodes:
  - id: review
    prompt: "Review"
    skills: []
`;
    const result = parseWorkflow(yaml, 'empty.yaml', providerRegistry);
    expect(result.error).toBeNull();
    expect((result.workflow?.nodes[0] as DagNode | undefined)?.skills).toEqual([]);
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
    const result = parseWorkflow(yaml, 'bash-skills.yaml', providerRegistry);
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    // Bash nodes don't get the skills field
    expect((wf.nodes[0] as DagNode).skills).toBeUndefined();
  });

  it('node with no skills has undefined skills field', () => {
    const yaml = `
name: no-skills
description: test
nodes:
  - id: basic
    prompt: "Do something"
`;
    const result = parseWorkflow(yaml, 'no-skills.yaml', providerRegistry);
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    expect((wf.nodes[0] as DagNode).skills).toBeUndefined();
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
        disallowedTools: [Write]
        skills: [codebase-search]
        maxTurns: 5
`;
    const result = parseWorkflow(yaml, 'agents.yaml', providerRegistry);
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    const node = wf.nodes[0] as DagNode;
    expect(node.agents).toEqual({
      'brief-gen': {
        description: 'Summarises an issue',
        prompt: 'You are concise. Return JSON { summary }.',
        model: 'haiku',
        tools: ['Bash', 'Read'],
        disallowedTools: ['Write'],
        skills: ['codebase-search'],
        maxTurns: 5,
      },
    });
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
    const result = parseWorkflow(yaml, 'missing-desc.yaml', providerRegistry);
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
    const result = parseWorkflow(yaml, 'missing-prompt.yaml', providerRegistry);
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
    const result = parseWorkflow(yaml, 'empty-agents.yaml', providerRegistry);
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
    const result = parseWorkflow(yaml, 'bad-id.yaml', providerRegistry);
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
    const result = parseWorkflow(yaml, 'bash-agents.yaml', providerRegistry);
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect((wf.nodes[0] as DagNode).agents).toBeUndefined();
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
    const result = parseWorkflow(yaml, 'script-agents.yaml', providerRegistry);
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect((wf.nodes[0] as DagNode).agents).toBeUndefined();
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
    const result = parseWorkflow(yaml, 'loop-agents.yaml', providerRegistry);
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect((wf.nodes[0] as DagNode).agents).toBeUndefined();
  });

  it('node with no agents field is undefined', () => {
    const yaml = `
name: no-agents
description: test
nodes:
  - id: basic
    prompt: "Do something"
`;
    const result = parseWorkflow(yaml, 'no-agents.yaml', providerRegistry);
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect((wf.nodes[0] as DagNode).agents).toBeUndefined();
  });
});
