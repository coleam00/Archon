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
import { existsSync } from 'node:fs';
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
import type { WorkflowItem, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowDeps } from '@archon/workflows/deps';
import { declaredOutcome } from '@archon/workflows/completed-outcome';
import { resolveWorkflowName } from '@archon/workflows/router';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { EndedCheckout } from './ended-checkout';
import { getArchonHome } from '@archon/paths';

/** `ARCHON_HOME/triggers`: where run-ended trigger files are read from. */
export function getTriggersPath(): string {
  return join(getArchonHome(), 'triggers');
}

/**
 * A trigger file in the triggers directory cannot be read as a binding. The message names
 * the file and what is wrong, so a reader can show it to the operator who owns the file.
 */
export class TriggerFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TriggerFileError';
  }
}

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
      throw new TriggerFileError(
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
    throw new TriggerFileError(
      `Trigger file ${file} is not readable JSON: ${(error as Error).message}`,
      {
        cause: error,
      }
    );
  }
  if (value === null || typeof value !== 'object' || !('on' in value)) return undefined;
  const parsed = triggerConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new TriggerFileError(
      `Trigger file ${file} is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`
    );
  const { on, sourceInstanceId, binding } = parsed.data;
  if (!on) return undefined;
  if (!isAbsolute(binding.launch.cwd))
    throw new TriggerFileError(
      `Trigger file ${file} is invalid: binding.launch.cwd must be absolute`
    );
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
  /**
   * The project a start from `cwd` runs in, or null when none is registered there or the
   * path is gone (see `launchProjectKey`).
   */
  projectKeyOf: (cwd: string) => Promise<string | null>;
  /**
   * The checkout the ended run left, for a binding with `checkout: "ended-run"`. Read at
   * most once per completion, and only when such a binding matches.
   */
  endedCheckout: (run: WorkflowRun) => Promise<EndedCheckout>;
  now?: () => Date;
}

/**
 * The receipts the completion of `ended` causes. Only a run on an item causes starts (a
 * `workflow:` child is created with no item). A binding matches when it names
 * the run's workflow and outcome and launches in the item's project. Each match gets its
 * own receipt, keyed by the binding's source and the ended run, so a replayed completion
 * could never start it twice even if it reached the store.
 */
export function createRunEndedStarts(
  dependencies: RunEndedStartsDependencies
): (ended: RunEndedFacts) => Promise<SourceReceiptAcceptance[]> {
  return async ended => {
    const { run } = ended;
    if (!run.item_id) return [];
    const candidates = (await readRunEndedBindings(dependencies.triggersDirectory())).filter(
      candidate => candidate.runEnded.workflowName === run.workflow_name
    );
    if (candidates.length === 0) return [];
    const item = await dependencies.getItem(run.item_id);
    if (!item) throw new Error(`Run '${run.id}' names item '${run.item_id}', which is missing`);
    const receipts: SourceReceiptAcceptance[] = [];
    let checkout: Promise<EndedCheckout> | undefined;
    for (const candidate of candidates) {
      // A binding that launches in another project is not about this item, even when a
      // workflow there has the same name.
      if ((await bindingProjectKey(candidate, dependencies)) !== item.projectKey) continue;
      const problems = runEndedBindingProblems(candidate.runEnded, ended);
      if (problems.length > 0)
        throw new Error(`Trigger file ${candidate.file}: ${problems.join('; ')}`);
      if (candidate.runEnded.outcome !== ended.outcome.value) continue;
      if (candidate.runEnded.checkout !== undefined) checkout ??= dependencies.endedCheckout(run);
      receipts.push(
        receiptFor(
          candidate,
          ended,
          item,
          candidate.runEnded.checkout === undefined ? undefined : await checkout,
          dependencies.now?.() ?? new Date()
        )
      );
    }
    return receipts;
  };
}

/**
 * The project of a start from `cwd`, for a binding's launch: null when the path no longer
 * exists. A start cannot launch from a missing checkout in any project, so a stale file is
 * not about this item; refusing it would fail every item run of its workflow, whatever
 * project the run is in.
 */
export function launchProjectKey(
  registered: (cwd: string) => Promise<string | null>
): (cwd: string) => Promise<string | null> {
  return async cwd => (existsSync(cwd) ? registered(cwd) : null);
}

/** The project a binding launches in; a failure to resolve it names the file. */
export async function bindingProjectKey(
  candidate: RunEndedBinding,
  dependencies: Pick<RunEndedStartsDependencies, 'projectKeyOf'>
): Promise<string | null> {
  try {
    return await dependencies.projectKeyOf(candidate.binding.launch.cwd);
  } catch (error) {
    throw new Error(
      `Trigger file ${candidate.file}: the project of binding.launch.cwd '${candidate.binding.launch.cwd}' could not be resolved: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

function receiptFor(
  candidate: RunEndedBinding,
  ended: RunEndedFacts,
  item: WorkflowItem,
  checkout: EndedCheckout | undefined,
  now: Date
): SourceReceiptAcceptance {
  const mapped = mappedInputs(candidate.runEnded, ended);
  const inputs = 'inputs' in mapped ? mapped.inputs : {};
  const refused =
    'missing' in mapped
      ? mapped.missing
      : checkout && 'refused' in checkout
        ? `Checkout: ${checkout.refused}`
        : undefined;
  const handoff = checkout && 'handoff' in checkout ? checkout.handoff : undefined;
  // Computed as `trigger fire` computes it, over the binding alone.
  const bindingRevision = createHash('sha256')
    .update(JSON.stringify(candidate.binding))
    .digest('hex');
  const content = refused ?? inputs;
  const receipt = {
    id: randomUUID(),
    sourceInstanceId: candidate.sourceInstanceId,
    deliveryId: ended.run.id,
    contentDigest: createHash('sha256')
      .update(JSON.stringify(handoff && refused === undefined ? [content, handoff] : content))
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
  if (refused !== undefined)
    return sourceReceiptAcceptanceSchema.parse({
      receipt,
      outcome: 'unmatched',
      // On the receipt as well as its binding, so `trigger list` shows why nothing started.
      reason: `${candidate.file}: ${refused}; '${candidate.binding.launch.workflowName}' was not started`,
      bindings: [],
      evaluatedBindings: [
        {
          bindingId: candidate.binding.bindingId,
          bindingRevision,
          status: 'rejected',
          reason: refused,
        },
      ],
    });
  const binding: ResourceStartBindingIntent = {
    ...candidate.binding,
    bindingRevision,
    ...(Object.keys(inputs).length > 0 ? { eventInputs: inputs } : {}),
    // `launch.isolation` names the branch for an older binary, which reads no hand-off: it
    // runs the stage on that branch or fails to check it out, never on the base branch.
    ...(handoff
      ? {
          launch: {
            ...candidate.binding.launch,
            isolation: { kind: 'worktree' as const, branch: handoff.branch },
          },
          checkoutFrom: handoff,
        }
      : {}),
  };
  return sourceReceiptAcceptanceSchema.parse({ receipt, outcome: 'matched', bindings: [binding] });
}

/** The input names a workflow declares: its own `inputs:` and its pack's settings. */
function declaredInputNames(workflow: Pick<ResolvedWorkflow, 'inputs' | 'pack'>): string[] {
  return [...Object.keys(workflow.inputs ?? {}), ...Object.keys(workflow.pack?.settings ?? {})];
}

/**
 * Every problem with a run-ended binding, read against the workflows of the project it
 * launches in: the ended workflow exists and declares the outcome and every input the
 * binding reads, and the started workflow exists and declares every input it maps. With
 * `checkout: "ended-run"`, neither workflow may be pinned in place. The
 * check a run gets before it starts; `runEndedTriggerCheck` reports it with the rest.
 */
export async function runEndedBindingCheck(
  { binding, runEnded }: RunEndedBinding,
  deps: Pick<WorkflowDeps, 'loadConfig' | 'providers'>
): Promise<string[]> {
  const discovered = await discoverWorkflowsWithConfig(
    binding.launch.discoveryCwd ?? binding.launch.cwd,
    deps.loadConfig,
    deps.providers
  );
  const workflows = discovered.workflows.map(found => found.workflow);
  const problems: string[] = [];
  // A completion matches the ended run's own name exactly, so this does too.
  const ended = workflows.find(workflow => workflow.name === runEnded.workflowName);
  const outcome = ended ? declaredOutcome(ended) : undefined;
  if (!ended) problems.push(`workflow '${runEnded.workflowName}' is not in this project`);
  else if (!outcome)
    problems.push(`workflow '${runEnded.workflowName}' declares no returns.outcome`);
  else
    problems.push(
      ...runEndedBindingProblems(runEnded, {
        outcomeForm: outcome.form,
        declaredInputs: declaredInputNames(ended),
      })
    );
  // A folder project leaves no worktree either; that is known only when a start is
  // prepared, which refuses it then, naming it.
  if (runEnded.checkout !== undefined && ended?.worktree?.enabled === false)
    problems.push(
      `workflow '${ended.name}' runs in place (worktree.enabled: false), so it leaves no checkout for checkout: ended-run`
    );
  const target = resolveWorkflowName(binding.launch.workflowName, workflows);
  if (!target) {
    problems.push(`workflow '${binding.launch.workflowName}' is not in this project`);
    return problems;
  }
  if (runEnded.checkout !== undefined && target.worktree?.enabled === false)
    problems.push(
      `workflow '${target.name}' runs in place (worktree.enabled: false), so it cannot take the ended run's checkout`
    );
  const declared = declaredInputNames(target);
  for (const name of Object.keys(runEnded.inputs ?? {}))
    if (!declared.includes(name))
      problems.push(`workflow '${target.name}' does not declare input '${name}'`);
  return problems;
}

/**
 * What `trigger check` prints, one problems list per binding in input order: the check a
 * run gets before it starts, plus what a run is not refused for. A missing `launch.cwd`
 * (the binding is skipped and never starts), a binding that starts the workflow that
 * ended it (a loop), and two files that start the same stage for the same end.
 */
export async function runEndedTriggerCheck(
  bindings: readonly RunEndedBinding[],
  deps: Pick<WorkflowDeps, 'loadConfig' | 'providers'> &
    Pick<RunEndedStartsDependencies, 'projectKeyOf'>
): Promise<string[][]> {
  const problems: string[][] = [];
  const stages = new Map<string, number[]>();
  for (const [index, candidate] of bindings.entries()) {
    const { binding, runEnded } = candidate;
    if (!existsSync(binding.launch.cwd)) {
      problems.push([
        `binding.launch.cwd '${binding.launch.cwd}' does not exist, so this binding never starts; fix the path or remove the file`,
      ]);
      continue;
    }
    // Starts match an item by project, so two checkouts of one project start the stage
    // twice; a path not registered yet is a project of its own.
    const project = (await bindingProjectKey(candidate, deps)) ?? binding.launch.cwd;
    const stage = JSON.stringify([
      project,
      runEnded.workflowName,
      runEnded.outcome,
      binding.launch.workflowName,
    ]);
    stages.set(stage, [...(stages.get(stage) ?? []), index]);
    const found = await runEndedBindingCheck(candidate, deps);
    if (binding.launch.workflowName === runEnded.workflowName)
      found.push(
        `binding starts '${runEnded.workflowName}', the workflow whose end fires it: each run that completes with '${runEnded.outcome}' starts another on the same item`
      );
    problems.push(found);
  }
  for (const group of stages.values()) {
    if (group.length < 2) continue;
    for (const index of group) {
      const others = group.filter(other => other !== index).map(other => bindings[other].file);
      problems[index].push(
        `binds the same outcome to the same stage as ${others.join(', ')}: the stage starts once per file on the item`
      );
    }
  }
  return problems;
}

/**
 * The check a run on an item gets before it starts: every run-ended binding its end
 * could fire, in its project, is checked in full, so a binding that names a missing
 * stage or an undeclared input is refused before the run does any work.
 */
export function createRunEndedPreflight(
  dependencies: Omit<RunEndedStartsDependencies, 'now' | 'endedCheckout'> &
    Pick<WorkflowDeps, 'loadConfig' | 'providers'>
): (run: WorkflowRun) => Promise<void> {
  return async run => {
    if (!run.item_id) return;
    const candidates = (await readRunEndedBindings(dependencies.triggersDirectory())).filter(
      candidate => candidate.runEnded.workflowName === run.workflow_name
    );
    if (candidates.length === 0) return;
    const item = await dependencies.getItem(run.item_id);
    if (!item) throw new Error(`Run '${run.id}' names item '${run.item_id}', which is missing`);
    for (const candidate of candidates) {
      if ((await bindingProjectKey(candidate, dependencies)) !== item.projectKey) continue;
      const problems = await runEndedBindingCheck(candidate, dependencies);
      if (problems.length > 0)
        throw new Error(`Trigger file ${candidate.file}: ${problems.join('; ')}`);
    }
  };
}
