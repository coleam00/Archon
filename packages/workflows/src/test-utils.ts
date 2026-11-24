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
import type { CapturedSourceOwner } from './run-source';
import type { IWorkflowStore, WorkflowEventInput } from './store';
import type { WorkflowEventRow } from './schemas/workflow-event';

const DEFAULT_NODE = { id: 'default', command: 'test-command' };

type TestWorkflowOverrides = {
  name: string;
  nodes?: unknown[];
} & Partial<Omit<WorkflowDefinition, 'name' | 'nodes'>>;

export function makeTestWorkflow(overrides: TestWorkflowOverrides): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse({
    description: `${overrides.name} test workflow`,
    nodes: [DEFAULT_NODE],
    ...overrides,
  });
  // `result` is the loader's normalization of `returns:`, not a schema key, so the parse drops it.
  return overrides.result === undefined ? workflow : { ...workflow, result: overrides.result };
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
        held = prepared.anchor.root;
        calls.push(`hold:${prepared.anchor.root}`);
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

/** Run the actual DAG only when an integration test asks for it. */
export async function executeTestDagWorkflow(
  options: Parameters<typeof import('./dag-executor').executeDagWorkflow>[0]
): ReturnType<typeof import('./dag-executor').executeDagWorkflow> {
  const { executeDagWorkflow } = await import('./dag-executor');
  return executeDagWorkflow(options);
}

/** A persisted workflow event as an in-memory test store records it. */
export interface InMemoryStoreEvent
  extends Pick<WorkflowEventInput, 'workflow_run_id' | 'step_index' | 'step_name' | 'data'> {
  event_type: string;
}

export function inMemoryEventRows(events: readonly InMemoryStoreEvent[]): WorkflowEventRow[] {
  return events.map((event, index) => ({
    ...event,
    id: `event-${String(index)}`,
    step_index: event.step_index ?? null,
    step_name: event.step_name ?? null,
    data: event.data ?? {},
    created_at: new Date(0).toISOString(),
    event_order: index,
  }));
}

// Throws rather than rejects, so a caller that discards the promise cannot hide the call.
const unexpectedStoreCall = (method: string) => (): never => {
  throw new Error(`Unexpected ${method}`);
};

/**
 * A prototype that answers every store method a double leaves out with `fallback(method)`,
 * which by default throws `Unexpected <method>`. Each fallback is made once, so a mock
 * fallback keeps its calls.
 *
 * It sits at the end of the double's prototype chain rather than wrapping the double:
 * Bun's `spyOn` silently does nothing on a Proxy, and tests spy on store doubles. The `has`
 * trap is what lets `spyOn` replace a method the double inherits from here.
 */
export function unsetStoreMethods(
  fallback: (method: string) => unknown = unexpectedStoreCall
): object {
  const made = new Map<string, unknown>();
  // Awaiting, printing or comparing a double probes `then`, `toJSON` and symbols; they are
  // not store methods, and answering them would make the double look like a promise.
  const isUnsetMethod = (target: object, key: string | symbol): key is string =>
    typeof key === 'string' && key !== 'then' && key !== 'toJSON' && !Reflect.has(target, key);
  return new Proxy(
    {},
    {
      get(target, key, receiver) {
        if (!isUnsetMethod(target, key)) return Reflect.get(target, key, receiver);
        if (!made.has(key)) made.set(key, fallback(key));
        return made.get(key);
      },
      has: (target, key) => isUnsetMethod(target, key) || Reflect.has(target, key),
    }
  );
}

/**
 * `T`, in a form TypeScript cannot infer `T` from. Not the built-in `NoInfer`: that needs
 * TypeScript 5.4, and this package declares `^5.0.0`.
 */
type NotInferred<T> = [T][T extends unknown ? 0 : never];

/**
 * A workflow store double built from only the methods a test needs: a copy of `implemented`
 * with `unsetStoreMethods(fallback)` as its prototype. Adding a method to the store needs no
 * edit in a double that never calls it, and a test that reaches one it did not set up
 * still fails naming it. An entry set to `undefined` counts as not set up.
 *
 * `S` is inferred neither from `implemented` nor from where the result is assigned: it is
 * `IWorkflowStore` unless a test names a wider store type, so a set-up method is always
 * checked against the store's signature. Spreading the double copies only the implemented
 * methods.
 */
export function workflowStoreDouble<S extends object = IWorkflowStore>(
  implemented: Partial<NotInferred<S>>,
  fallback?: (method: string) => unknown
): NotInferred<S> {
  // A fresh copy without the `undefined` entries, so none of them shadows its fallback.
  const double: Record<string, unknown> = Object.create(unsetStoreMethods(fallback));
  for (const [key, value] of Object.entries(implemented)) {
    if (value !== undefined) double[key] = value;
  }
  // Sound: every key the copy lacks resolves through the prototype's fallback.
  return double as NotInferred<S>;
}
