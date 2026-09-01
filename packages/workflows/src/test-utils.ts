/**
 * Test factories for workflow types.
 * Use these instead of inline fixture objects — schema changes update one file.
 */
import { workflowDefinitionSchema } from './schemas/workflow';
import type {
  DeclaredWorkflowConfig,
  ResolvedWorkflow,
  WorkflowDefinition,
  WorkflowWithSource,
  WorkflowSource,
} from './schemas/workflow';
import { expandWorkflowIncludes } from './include-expander';
import { resolveWorkflow } from './graph-plan';
import type { CapturedSourceOwner } from './executor';

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

export function makeTestResolvedWorkflow(overrides: TestWorkflowOverrides): ResolvedWorkflow {
  return resolveWorkflow(makeTestWorkflow(overrides));
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
  const { workflows, errors } = expandWorkflowIncludes(new Map([[raw.name, raw]]));
  const workflow = workflows.get(raw.name);
  if (workflow === undefined) {
    throw new Error(`makeTestWorkflowWithSource: expansion failed: ${JSON.stringify(errors)}`);
  }
  const declared: DeclaredWorkflowConfig = {
    ...(raw.provider !== undefined ? { provider: raw.provider } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
  };
  return {
    workflow,
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
): ResolvedWorkflow {
  const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
  if (errors.length > 0) {
    throw new Error(`makeTestComposedWorkflow: expansion failed: ${JSON.stringify(errors)}`);
  }
  const expanded = workflows.get(name);
  if (!expanded) throw new Error(`makeTestComposedWorkflow: no workflow named '${name}'`);
  return expanded;
}

/**
 * Run a capture-owner body with the production hold/adopt/reclaim lifecycle while
 * recording each transition. Cross-package tests use this as the observable
 * implementation behind their mocked `withCapturedSource` export.
 */
export async function withObservableCapturedSource<T>(
  calls: string[],
  body: (owner: CapturedSourceOwner) => Promise<T>
): Promise<T> {
  let held: string | undefined;
  let adopted = false;
  try {
    return await body({
      hold: prepared => {
        held = prepared.captureRoot;
        calls.push(`hold:${prepared.captureRoot}`);
      },
      adopt: () => {
        adopted = true;
        calls.push('adopt');
      },
    });
  } finally {
    if (held && !adopted) calls.push(`reclaim:${held}`);
  }
}
