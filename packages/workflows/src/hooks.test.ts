// @archon-test-isolated
import { providerRegistry } from '@archon/providers';
import { describe, test, expect } from 'bun:test';
import { buildSDKHooksFromYAML } from '@archon/providers/claude';
import type { WorkflowNodeHooks, DagNode } from './schemas';
import { dagNodeSchema } from './schemas';
import { parseWorkflow } from './loader';

describe('buildSDKHooksFromYAML', () => {
  test('single event with one matcher creates SDK structure', () => {
    const nodeHooks: WorkflowNodeHooks = {
      PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }],
    };
    const sdk = buildSDKHooksFromYAML(nodeHooks);
    expect(sdk.PreToolUse).toHaveLength(1);
    expect(sdk.PreToolUse![0].matcher).toBe('Bash');
    expect(sdk.PreToolUse![0].hooks).toHaveLength(1);
  });

  test('calling the callback returns response object unchanged', async () => {
    const response = {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    };
    const nodeHooks: WorkflowNodeHooks = {
      PreToolUse: [{ response }],
    };
    const sdk = buildSDKHooksFromYAML(nodeHooks);
    const callback = sdk.PreToolUse![0].hooks[0];
    const result = await callback(null, undefined, { signal: new AbortController().signal });
    expect(result).toEqual(response);
  });

  test('matcher field propagated to SDK structure', () => {
    const nodeHooks: WorkflowNodeHooks = {
      PreToolUse: [{ matcher: 'Write|Edit', response: { x: 1 } }],
    };
    const sdk = buildSDKHooksFromYAML(nodeHooks);
    expect(sdk.PreToolUse![0].matcher).toBe('Write|Edit');
  });

  test('timeout field propagated to SDK structure', () => {
    const nodeHooks: WorkflowNodeHooks = {
      PreToolUse: [{ response: { x: 1 }, timeout: 120 }],
    };
    const sdk = buildSDKHooksFromYAML(nodeHooks);
    expect(sdk.PreToolUse![0].timeout).toBe(120);
  });

  test('absent matcher has no matcher field on SDK structure', () => {
    const nodeHooks: WorkflowNodeHooks = {
      PostToolUse: [{ response: { systemMessage: 'check' } }],
    };
    const sdk = buildSDKHooksFromYAML(nodeHooks);
    expect('matcher' in sdk.PostToolUse![0]).toBe(false);
  });

  test('multiple matchers per event creates multiple entries', () => {
    const nodeHooks: WorkflowNodeHooks = {
      PreToolUse: [
        { matcher: 'Bash', response: { a: 1 } },
        { matcher: 'Write', response: { b: 2 } },
      ],
    };
    const sdk = buildSDKHooksFromYAML(nodeHooks);
    expect(sdk.PreToolUse).toHaveLength(2);
    expect(sdk.PreToolUse![0].matcher).toBe('Bash');
    expect(sdk.PreToolUse![1].matcher).toBe('Write');
  });
});

describe('parseWorkflow with hooks', () => {
  test.each([0, 1, 2])('rejects unknown hook events at loop-group depth %i', depth => {
    const knownHooks: WorkflowNodeHooks = { PreToolUse: [{ response: { decision: 'block' } }] };
    const wrap = (hooks: object): object => {
      let node: object = { id: 'gen', prompt: 'Generate code', hooks };
      for (let i = 0; i < depth; i++) {
        node = {
          id: `group-${i}`,
          loop_group: { until: 'DONE', max_iterations: 2, nodes: [node] },
        };
      }
      return node;
    };

    expect(dagNodeSchema.safeParse(wrap(knownHooks)).success).toBe(true);
    const result = dagNodeSchema.safeParse(
      wrap({ ...knownHooks, FakeEvent: [{ response: { decision: 'block' } }] })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.at(-1) === 'hooks')).toBe(true);
      expect(result.error.message).toContain('FakeEvent');
    }
  });

  test('full YAML with hooks field on a node parses correctly', () => {
    const yaml = `
name: test-hooks
description: Test workflow with hooks
nodes:
  - id: gen
    prompt: "Generate code"
    hooks:
      PreToolUse:
        - matcher: "Bash"
          timeout: 30
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
      PostToolUse:
        - response:
            systemMessage: "Verify output"
`;
    const result = parseWorkflow(yaml, 'test.yaml', providerRegistry);
    expect(result.error).toBeNull();
    const workflow = result.workflow!;
    expect(workflow.nodes).toBeDefined();
    const node = workflow.nodes![0] as DagNode;
    expect(node.hooks).toBeDefined();
    expect(node.hooks!.PreToolUse).toHaveLength(1);
    expect(node.hooks!.PreToolUse![0].matcher).toBe('Bash');
    expect(node.hooks!.PreToolUse![0].timeout).toBe(30);
    expect(node.hooks!.PostToolUse).toHaveLength(1);
  });

  test.each([
    ['a string', '"bad"'],
    ['an array', '[]'],
    ['null', 'null'],
    ['an unknown event', '{ FakeEvent: [{ response: { x: 1 } }] }'],
    ['non-array matchers', '{ PreToolUse: "bad" }'],
    ['a matcher without response', '{ PreToolUse: [{ matcher: Bash }] }'],
    ['a string response', '{ PreToolUse: [{ response: "bad" }] }'],
    ['an array response', '{ PreToolUse: [{ response: [] }] }'],
  ])('rejects hooks given as %s', (_label, hooks) => {
    const yaml = `
name: test-bad-hooks
description: Test workflow with malformed hooks
nodes:
  - id: gen
    prompt: "Generate code"
    hooks: ${hooks}
`;
    const result = parseWorkflow(yaml, 'test.yaml', providerRegistry);
    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain("Node 'gen': 'hooks");
  });

  test('hooks on bash node are warned and excluded', () => {
    const yaml = `
name: test-bash-hooks
description: Test bash node with hooks
nodes:
  - id: run
    bash: "echo hello"
    hooks:
      PreToolUse:
        - response:
            decision: block
`;
    const result = parseWorkflow(yaml, 'test.yaml', providerRegistry);
    // Bash nodes ignore AI fields including hooks — the node should parse successfully
    // but hooks should not be on the parsed node
    expect(result.error).toBeNull();
    const node = result.workflow!.nodes![0] as DagNode;
    expect(node.hooks).toBeUndefined();
  });
});
