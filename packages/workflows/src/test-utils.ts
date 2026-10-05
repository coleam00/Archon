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
import { readNodeRecordEvent, nodeInvocationKey } from './node-record-reader';
import { nodeCostScope } from './node-record-serialization';
import { NODE_STATE_EVENT_TYPES } from './store';
import type { DagResumeSnapshot, PersistedNodeOutput } from './store';

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
export interface InMemoryStoreEvent {
  workflow_run_id: string;
  event_type: string;
  step_name?: string;
  data?: Record<string, unknown>;
}

/**
 * Rebuild a DAG resume snapshot from an in-memory event log, for test doubles of
 * `IWorkflowStore.getDagResumeSnapshot`. It models the subset of the real store's fold
 * that workflow-package tests exercise; core's `workflow-events.test.ts` runs the same
 * rows through both so the output selection and usage scope cannot drift unnoticed.
 */
export function inMemoryDagResumeSnapshot(
  events: readonly InMemoryStoreEvent[],
  workflowRunId: string
): DagResumeSnapshot {
  const completedNodeOutputs = new Map<string, PersistedNodeOutput>();
  const unfinishedInvocations: NonNullable<DagResumeSnapshot['unfinishedInvocations']> = new Map();
  const tokens = { input: 0, output: 0 };
  let costUsd = 0;
  for (const e of events) {
    if (
      e.workflow_run_id !== workflowRunId ||
      !NODE_STATE_EVENT_TYPES.some(type => type === e.event_type) ||
      typeof e.step_name !== 'string'
    )
      continue;
    const record = readNodeRecordEvent({ ...e, data: e.data });
    if (record?.metadata !== undefined) {
      const execution = record.metadata;
      const key = nodeInvocationKey(record.path, execution.invocation.loopPath);
      if (
        execution.lifecycle.status === 'started' ||
        execution.lifecycle.status === 'failed' ||
        execution.lifecycle.status === 'suspended'
      ) {
        unfinishedInvocations.set(key, execution);
      } else {
        unfinishedInvocations.delete(key);
      }
    } else if (
      record?.eventType === 'node_skipped_prior_success' ||
      record?.eventType === 'node_always_run_reset' ||
      record?.eventType === 'node_prior_cache_invalidated'
    ) {
      for (const [key, execution] of unfinishedInvocations) {
        if (execution.path === record.path) unfinishedInvocations.delete(key);
      }
    }
    // Every later node state supersedes reusable success; only a success restores it.
    completedNodeOutputs.delete(e.step_name);
    if (e.event_type !== 'node_completed' && e.event_type !== 'node_skipped_prior_success')
      continue;
    if (typeof e.data?.node_output === 'string') {
      // The logical value rides beside the text (#2637), and the field contract the
      // node completed under rides beside both (#2453), read through the real reader.
      const declaredOutputPaths = readNodeRecordEvent({ ...e, data: e.data })?.data
        .declared_output_paths;
      completedNodeOutputs.set(e.step_name, {
        output: e.data.node_output,
        ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
        ...(e.data.structured_output !== undefined
          ? { structuredOutput: e.data.structured_output }
          : {}),
      });
    }
    // A derived row (loop_group roll-up) restates usage other rows already carry, so it
    // contributes output but never usage (#2469).
    if (e.event_type !== 'node_completed' || nodeCostScope(e.data ?? {}) === 'total') continue;
    const eventTokens = e.data?.tokens;
    if (
      typeof eventTokens === 'object' &&
      eventTokens !== null &&
      'input' in eventTokens &&
      'output' in eventTokens &&
      typeof eventTokens.input === 'number' &&
      typeof eventTokens.output === 'number' &&
      Number.isFinite(eventTokens.input) &&
      Number.isFinite(eventTokens.output)
    ) {
      tokens.input += eventTokens.input;
      tokens.output += eventTokens.output;
    }
    const eventCost = e.data?.cost_usd;
    if (typeof eventCost === 'number' && Number.isFinite(eventCost)) {
      costUsd += eventCost;
    }
  }
  return {
    completedNodeOutputs,
    unfinishedInvocations,
    fanOutSnapshots: new Map(),
    unresolvedNodeStarts: new Set(),
    tokens,
    costUsd,
  };
}
