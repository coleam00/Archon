/**
 * Run-ended bindings: a trigger file in `ARCHON_HOME/triggers/` with `on.runEnded` starts
 * its binding when a run of the named workflow completes with the named outcome on an
 * item. The receipts built here are written by the write that completes the run, so a
 * start exists exactly when the end does, and then go through the one start path:
 * preparation, admission, capacity and the item.
 *
 * The deployment owns these files. They are read from the install's home only, never
 * from a repository, and fresh at every completion, so removing a file turns it off.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { RunEndedFacts } from '@archon/workflows/deps';
import { resolveJsonPointer } from '@archon/workflows/json-pointer';
import type { JsonValue } from '@archon/workflows/output-ref';
import {
  RUN_ENDED_SOURCE_ACTOR,
  sourceReceiptAcceptanceSchema,
  triggerConfigSchema,
  type ResourceStartBindingIntent,
  type RunEndedTrigger,
  type SourceReceiptAcceptance,
  type TriggerConfig,
} from '@archon/workflows/schemas/resource-start';
import type { WorkflowItem } from '@archon/workflows/schemas/workflow-run';

/** A trigger file whose binding the end of a run starts. */
export interface RunEndedBinding {
  file: string;
  sourceInstanceId: string;
  binding: TriggerConfig['binding'];
  runEnded: RunEndedTrigger;
}

/**
 * Every run-ended binding in `directory`, in file-name order. A file without `on` is a
 * schedule or fire-only binding and is not read further. A file that is not JSON, or
 * whose `on` is invalid, throws naming the file: whether it was meant to start a stage
 * cannot be known, so the completion that reads it must not guess.
 */
export async function readRunEndedBindings(directory: string): Promise<RunEndedBinding[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const bindings: RunEndedBinding[] = [];
  const bySource = new Map<string, string>();
  for (const name of names) {
    const binding = await readRunEndedFile(join(directory, name));
    if (!binding) continue;
    // The ended run's id is every receipt's delivery id, so two files with one source
    // would collide on it and the second start would replay as the first.
    const other = bySource.get(binding.sourceInstanceId);
    if (other)
      throw new Error(
        `Trigger files ${other} and ${binding.file} share sourceInstanceId '${binding.sourceInstanceId}'; each run-ended binding needs its own`
      );
    bySource.set(binding.sourceInstanceId, binding.file);
    bindings.push(binding);
  }
  return bindings;
}

/** One trigger file as a run-ended binding, or undefined when it has no `on`. */
async function readRunEndedFile(file: string): Promise<RunEndedBinding | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Trigger file ${file} is not readable JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (value === null || typeof value !== 'object' || !('on' in value)) return undefined;
  const parsed = triggerConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Trigger file ${file} is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`
    );
  const { on, sourceInstanceId, binding } = parsed.data;
  if (!on) return undefined;
  if (!isAbsolute(binding.launch.cwd))
    throw new Error(`Trigger file ${file} is invalid: binding.launch.cwd must be absolute`);
  return { file, sourceInstanceId, binding, runEnded: on.runEnded };
}

/**
 * Why a binding for this ended workflow cannot be read against it, or undefined. Each
 * problem is the operator's to fix in the file, so it is refused, not skipped.
 */
export function runEndedBindingProblems(
  runEnded: RunEndedTrigger,
  ended: Pick<RunEndedFacts, 'declaredInputs' | 'outcomeForm'>
): string[] {
  const problems: string[] = [];
  const form = ended.outcomeForm;
  const values = form.kind === 'enum' ? form.values : ['succeeded', 'failed'];
  if (!values.includes(runEnded.outcome))
    problems.push(
      `outcome '${runEnded.outcome}' is not one '${runEnded.workflowName}' completes with (${values.map(value => `'${value}'`).join(', ')})`
    );
  for (const [target, source] of Object.entries(runEnded.inputs ?? {}))
    if ('input' in source && !ended.declaredInputs.includes(source.input))
      problems.push(
        `input '${target}' reads '${source.input}', which '${runEnded.workflowName}' does not declare`
      );
  return problems;
}

/** The target inputs a binding maps from the ended run, or the first that did not resolve. */
function mappedInputs(
  runEnded: RunEndedTrigger,
  ended: RunEndedFacts
): { inputs: Record<string, JsonValue> } | { missing: string } {
  const inputs: Record<string, JsonValue> = {};
  for (const [target, source] of Object.entries(runEnded.inputs ?? {})) {
    if ('input' in source) {
      // A declared input the run was not given passes nothing; the target's own
      // declaration decides at preparation whether that start can run.
      const value = ended.inputs[source.input];
      if (value !== undefined) inputs[target] = value;
      continue;
    }
    const value =
      ended.result === undefined ? undefined : resolveJsonPointer(ended.result, source.result);
    if (value === undefined)
      return { missing: `Input '${target}': result pointer '${source.result}' did not resolve` };
    inputs[target] = value;
  }
  return { inputs };
}

export interface RunEndedStartsDependencies {
  /** The directory the trigger files are read from: `ARCHON_HOME/triggers`. */
  triggersDirectory: () => string;
  getItem: (id: string) => Promise<WorkflowItem | null>;
  /** The project a start from `cwd` runs in, or null when none is registered there. */
  projectKeyOf: (cwd: string) => Promise<string | null>;
  now?: () => Date;
}

/**
 * The receipts the completion of `ended` causes. Only a run on an item with no parent
 * causes starts: a child's end is its parent's business. A binding matches when it names
 * the run's workflow and outcome and launches in the item's project. Each match gets its
 * own receipt, keyed by the binding's source and the ended run, so a replayed completion
 * could never start it twice even if it reached the store.
 */
export function createRunEndedStarts(
  dependencies: RunEndedStartsDependencies
): (ended: RunEndedFacts) => Promise<SourceReceiptAcceptance[]> {
  return async ended => {
    const { run } = ended;
    if (!run.item_id || run.parent_run_id) return [];
    const candidates = (await readRunEndedBindings(dependencies.triggersDirectory())).filter(
      candidate => candidate.runEnded.workflowName === run.workflow_name
    );
    if (candidates.length === 0) return [];
    const item = await dependencies.getItem(run.item_id);
    if (!item) throw new Error(`Run '${run.id}' names item '${run.item_id}', which is missing`);
    const receipts: SourceReceiptAcceptance[] = [];
    for (const candidate of candidates) {
      // A binding that launches in another project is not about this item, even when a
      // workflow there has the same name.
      if ((await dependencies.projectKeyOf(candidate.binding.launch.cwd)) !== item.projectKey)
        continue;
      const problems = runEndedBindingProblems(candidate.runEnded, ended);
      if (problems.length > 0)
        throw new Error(`Trigger file ${candidate.file}: ${problems.join('; ')}`);
      if (candidate.runEnded.outcome !== ended.outcome.value) continue;
      receipts.push(receiptFor(candidate, ended, item, dependencies.now?.() ?? new Date()));
    }
    return receipts;
  };
}

function receiptFor(
  candidate: RunEndedBinding,
  ended: RunEndedFacts,
  item: WorkflowItem,
  now: Date
): SourceReceiptAcceptance {
  const mapped = mappedInputs(candidate.runEnded, ended);
  // Computed as `trigger fire` computes it, over the binding alone.
  const bindingRevision = createHash('sha256')
    .update(JSON.stringify(candidate.binding))
    .digest('hex');
  const receipt = {
    id: randomUUID(),
    sourceInstanceId: candidate.sourceInstanceId,
    deliveryId: ended.run.id,
    contentDigest: createHash('sha256')
      .update(JSON.stringify('inputs' in mapped ? mapped.inputs : mapped.missing))
      .digest('hex'),
    receivedAt: now.toISOString(),
    occurredAt: null,
    sourceActor: {
      source: RUN_ENDED_SOURCE_ACTOR,
      id: ended.run.id,
      ...(ended.outcome.value === '' ? {} : { display: ended.outcome.value }),
    },
    itemKey: item.key,
  };
  if ('missing' in mapped)
    return sourceReceiptAcceptanceSchema.parse({
      receipt,
      outcome: 'unmatched',
      bindings: [],
      evaluatedBindings: [
        {
          bindingId: candidate.binding.bindingId,
          bindingRevision,
          status: 'rejected',
          reason: mapped.missing,
        },
      ],
    });
  const binding: ResourceStartBindingIntent = {
    ...candidate.binding,
    bindingRevision,
    ...(Object.keys(mapped.inputs).length > 0 ? { eventInputs: mapped.inputs } : {}),
  };
  return sourceReceiptAcceptanceSchema.parse({ receipt, outcome: 'matched', bindings: [binding] });
}
