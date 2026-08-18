/**
 * Test factories for workflow types.
 * Use these instead of inline fixture objects — schema changes update one file.
 */
import { workflowDefinitionSchema } from './schemas/workflow';
import type {
  DeclaredWorkflowConfig,
  WorkflowDefinition,
  WorkflowWithSource,
  WorkflowSource,
} from './schemas/workflow';
import { expandWorkflowIncludes } from './include-expander';

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

/**
 * Wrap a WorkflowDefinition as a WorkflowWithSource entry for test mocks.
 *
 * Runs the real expander, so the entry has the shape discovery actually produces: the
 * workflow's node-affecting config collapsed onto its nodes and removed from the
 * definition, with what the author declared carried alongside in `declared` (#1764). A
 * factory that skipped this would hand every consumer a `workflow.provider` that no real
 * discovery result has, and hide exactly the display bug the collapse introduces.
 */
export function makeTestWorkflowWithSource(
  overrides: TestWorkflowOverrides,
  source: WorkflowSource = 'bundled',
  parseWarnings?: readonly string[]
): WorkflowWithSource {
  const raw = makeTestWorkflow(overrides);
  const { workflows } = expandWorkflowIncludes(new Map([[raw.name, raw]]));
  const declared: DeclaredWorkflowConfig = {
    ...(raw.provider !== undefined ? { provider: raw.provider } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
  };
  return {
    workflow: workflows.get(raw.name) ?? raw,
    source,
    ...(parseWarnings ? { parseWarnings } : {}),
    ...(Object.keys(declared).length > 0 ? { declared } : {}),
  };
}

/**
 * Expand a set of in-memory workflows exactly as discovery does, and return one by name.
 *
 * For tests OUTSIDE this package that need a genuinely composed workflow — the expander
 * itself is not a public export, and composition is where several cross-package contracts
 * are decided (unioned `requires:`, collapsed node config, the composed-node stamp).
 * Throws on an expansion error so a broken fixture fails loudly at its own line.
 */
export function makeTestComposedWorkflow(
  defs: readonly WorkflowDefinition[],
  name: string
): WorkflowDefinition {
  const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
  if (errors.length > 0) {
    throw new Error(`makeTestComposedWorkflow: expansion failed: ${JSON.stringify(errors)}`);
  }
  const expanded = workflows.get(name);
  if (!expanded) throw new Error(`makeTestComposedWorkflow: no workflow named '${name}'`);
  return expanded;
}
