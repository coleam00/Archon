/**
 * Test factories for workflow types.
 * Use these instead of inline fixture objects — schema changes update one file.
 */
import { workflowDefinitionSchema } from './schemas/workflow';
import type { WorkflowDefinition, WorkflowWithSource, WorkflowSource } from './schemas/workflow';

const DEFAULT_NODE = { id: 'default', command: 'test-command' };

type TestWorkflowOverrides = {
  name: string;
  nodes?: unknown[];
} & Partial<Omit<WorkflowDefinition, 'name' | 'nodes'>>;

export function makeTestWorkflow(overrides: TestWorkflowOverrides): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    description: `${overrides.name} test workflow`,
    nodes: [DEFAULT_NODE],
    ...overrides,
  });
}

export function makeTestWorkflowList(names: string[]): WorkflowDefinition[] {
  return names.map(name => makeTestWorkflow({ name }));
}

/** Wrap a WorkflowDefinition as a WorkflowWithSource entry for test mocks. */
export function makeTestWorkflowWithSource(
  overrides: TestWorkflowOverrides,
  source: WorkflowSource = 'bundled'
): WorkflowWithSource {
  return { workflow: makeTestWorkflow(overrides), source };
}
