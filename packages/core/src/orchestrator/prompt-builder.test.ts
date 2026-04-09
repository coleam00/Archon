import { describe, test, expect } from 'bun:test';
import { buildRoutingRulesWithProject } from './prompt-builder';

describe('buildRoutingRulesWithProject', () => {
  test('routing rules instruct Claude to call invoke_workflow tool', () => {
    const rules = buildRoutingRulesWithProject();

    expect(rules).toContain('invoke_workflow');
    expect(rules).toContain('call the');
  });

  test('routing rules include task_description parameter', () => {
    const rules = buildRoutingRulesWithProject();

    expect(rules).toContain('task_description');
    expect(rules).toContain('self-contained');
  });

  test('routing rules mention invoke_workflow tool with project-scoped prompt', () => {
    const rules = buildRoutingRulesWithProject('my-project');

    expect(rules).toContain('invoke_workflow');
    expect(rules).toContain('my-project');
  });

  test('rules state task_description must have NO knowledge of conversation', () => {
    const rules = buildRoutingRulesWithProject();

    expect(rules).toContain('NO knowledge of this conversation');
  });

  test('rules do NOT instruct Claude to output /invoke-workflow as text', () => {
    const rules = buildRoutingRulesWithProject();

    // The new format tells Claude NOT to use the text command
    expect(rules).not.toContain('output the command as the VERY LAST line');
    expect(rules).toContain('Do NOT output');
  });
});
