import { describe, test, expect } from 'bun:test';
import { parseNodeHooks } from './loader';
import { buildSDKHooksFromYAML } from '@archon/providers/claude/provider';
import type { WorkflowNodeHooks } from './schemas';
import { parseWorkflow } from './loader';

describe('parseNodeHooks', () => {
  test('undefined returns undefined', () => {
    const errors: string[] = [];
    expect(parseNodeHooks(undefined, { id: 'test', errors })).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  test('non-object (string) pushes error and returns undefined', () => {
    const errors: string[] = [];
    expect(parseNodeHooks('bad', { id: 'test', errors })).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('hooks');
  });

  test('non-object (array) pushes error and returns undefined', () => {
    const errors: string[] = [];
    expect(parseNodeHooks([], { id: 'test', errors })).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('hooks');
  });

  test('non-object (null) pushes error and returns undefined', () => {
    const errors: string[] = [];
    expect(parseNodeHooks(null, { id: 'test', errors })).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  test('unknown event name pushes error', () => {
    const errors: string[] = [];
    parseNodeHooks({ FakeEvent: [{ response: { x: 1 } }] }, { id: 'test', errors });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('FakeEvent');
  });

  test('valid event with non-array matchers pushes error', () => {
    const errors: string[] = [];
    parseNodeHooks({ PreToolUse: 'bad' }, { id: 'test', errors });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('PreToolUse');
  });

  test('matcher missing response pushes error', () => {
    const errors: string[] = [];
    parseNodeHooks({ PreToolUse: [{ matcher: 'Bash' }] }, { id: 'test', errors });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('response');
  });

  test('matcher with string response pushes error', () => {
    const errors: string[] = [];
    parseNodeHooks({ PreToolUse: [{ response: 'bad' }] }, { id: 'test', errors });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('response');
  });

  test('matcher with array response pushes error', () => {
    const errors: string[] = [];
    parseNodeHooks({ PreToolUse: [{ response: [] }] }, { id: 'test', errors });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('response');
  });

  test('valid PreToolUse with matcher and response returns parsed structure', () => {
    const errors: string[] = [];
    const result = parseNodeHooks(
      { PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }] },
      { id: 'test', errors }
    );
    expect(errors).toHaveLength(0);
    expect(result).toEqual({
      PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }],
    });
  });

  test('valid PostToolUse without matcher returns parsed', () => {
    const errors: string[] = [];
    const result = parseNodeHooks(
      { PostToolUse: [{ response: { systemMessage: 'check output' } }] },
      { id: 'test', errors }
    );
    expect(errors).toHaveLength(0);
    expect(result).toEqual({
      PostToolUse: [{ response: { systemMessage: 'check output' } }],
    });
  });

  test('timeout field preserved when positive number', () => {
    const errors: string[] = [];
    const result = parseNodeHooks(
      { PreToolUse: [{ response: { x: 1 }, timeout: 30 }] },
      { id: 'test', errors }
    );
    expect(errors).toHaveLength(0);
    expect(result?.PreToolUse?.[0]?.timeout).toBe(30);
  });

  test('empty hooks object returns undefined', () => {
    const errors: string[] = [];
    expect(parseNodeHooks({}, { id: 'test', errors })).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  test('multiple events with multiple matchers parsed correctly', () => {
    const errors: string[] = [];
    const result = parseNodeHooks(
      {
        PreToolUse: [
          { matcher: 'Bash', response: { decision: 'block' } },
          { matcher: 'Write', response: { decision: 'block' } },
        ],
        PostToolUse: [{ response: { systemMessage: 'verify' } }],
      },
      { id: 'test', errors }
    );
    expect(errors).toHaveLength(0);
    expect(result?.PreToolUse).toHaveLength(2);
    expect(result?.PostToolUse).toHaveLength(1);
  });

  test('event with empty matchers array returns undefined (event filtered out)', () => {
    const errors: string[] = [];
    const result = parseNodeHooks({ PreToolUse: [] }, { id: 'test', errors });
    expect(errors).toHaveLength(0);
    // Empty array means no matchers, so the whole hooks result is undefined
    expect(result).toBeUndefined();
  });
});

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
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
      PostToolUse:
        - response:
            systemMessage: "Verify output"
`;
    const result = parseWorkflow(yaml, 'test.yaml');
    expect(result.error).toBeNull();
    const workflow = result.workflow!;
    expect(workflow.nodes).toBeDefined();
    const node = workflow.nodes![0];
    expect(node.hooks).toBeDefined();
    expect(node.hooks!.PreToolUse).toHaveLength(1);
    expect(node.hooks!.PreToolUse![0].matcher).toBe('Bash');
    expect(node.hooks!.PostToolUse).toHaveLength(1);
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
    const result = parseWorkflow(yaml, 'test.yaml');
    // Bash nodes ignore AI fields including hooks — the node should parse successfully
    // but hooks should not be on the parsed node
    expect(result.error).toBeNull();
    const node = result.workflow!.nodes![0];
    expect(node.hooks).toBeUndefined();
  });
});
