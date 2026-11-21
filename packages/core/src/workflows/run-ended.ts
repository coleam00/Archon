/**
 * Run-ended bindings: a trigger file in `ARCHON_HOME/triggers/` with `on.runEnded` starts
 * its binding when a run of the named workflow completes with the named outcome on an
 * item, on that item or, with `linked`, on the items linked to it. The receipts built
 * here are written by the write that completes the run, so a start exists exactly when
 * the end does, and then go through the one start path: preparation, admission, capacity
 * and the item. A linked start is matched here and resolved by that write, which alone
 * can read the links as they are when the run completes.
 *
 * The deployment owns these files. They are read from the install's home only, never
 * from a repository, and fresh at every completion, so removing a file turns it off.
 * The same files hold asks-settled bindings (`asks-settled.ts`); this module reads both
 * forms and builds the receipt either form writes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { RunEndedFacts, RunEndedStarts } from '@archon/workflows/deps';
import { resolveJsonPointer } from '@archon/workflows/json-pointer';
import type { JsonValue } from '@archon/workflows/output-ref';
import {
  RUN_ENDED_SOURCE_ACTOR,
  sourceReceiptAcceptanceSchema,
  triggerConfigSchema,
  type AsksSettledTrigger,
  type LinkedRunEndedStart,
  type ResourceStartBindingIntent,
  type RunEndedTrigger,
  type SourceReceiptAcceptance,
  type SourceReceiptInput,
  type TriggerConfig,
} from '@archon/workflows/schemas/resource-start';
import type { WorkflowItem, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowDeps } from '@archon/workflows/deps';
import { declaredOutcome, outcomeValues } from '@archon/workflows/completed-outcome';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { EndedCheckout } from '@archon/workflows/schemas/resource-start';
import { getArchonHome } from '@archon/paths';
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import {
  readsItemAnswers,
  type AsksSettledInputSource,
  type RunEndedInputSource,
} from '@archon/workflows/schemas/binding-input-source';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import { selectStartedWorkflow, type StartedWorkflow } from './binding-workflow';
import { itemAnswers, type ItemAnswers } from './item-answers';

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

/** A trigger file with `on`: what every form shares. */
interface OnBindingFile {
  file: string;
  sourceInstanceId: string;
  binding: TriggerConfig['binding'];
}

/** A trigger file whose binding the end of a run starts. */
export interface RunEndedBinding extends OnBindingFile {
  runEnded: RunEndedTrigger;
}

/** A trigger file whose binding the settling of a run's asks starts (see `asks-settled`). */
export interface AsksSettledBinding extends OnBindingFile {
  asksSettled: AsksSettledTrigger;
}

export type OnBinding = RunEndedBinding | AsksSettledBinding;

/**
 * Every trigger file in `directory` with `on`, in file-name order. A file without `on` is
 * a schedule or fire-only binding and is not read further. A file that is not JSON, or
 * whose `on` is invalid, throws naming the file: whether it was meant to start a stage
 * cannot be known, so the write that reads it must not guess.
 */
export async function readOnBindings(directory: string): Promise<OnBinding[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const bindings: OnBinding[] = [];
  const bySource = new Map<string, string>();
  for (const name of names) {
    const binding = await readOnFile(join(directory, name));
    if (!binding) continue;
    // Both forms make every receipt's delivery id from the run (and a linked start's from
    // its holder) without the file, so two files with one source would collide on it and
    // the second start would replay as the first.
    const other = bySource.get(binding.sourceInstanceId);
    if (other)
      throw new TriggerFileError(
        `Trigger files ${other} and ${binding.file} share sourceInstanceId '${binding.sourceInstanceId}'; each run-ended or asks-settled binding needs its own`
      );
    bySource.set(binding.sourceInstanceId, binding.file);
    bindings.push(binding);
  }
  return bindings;
}

/** Every run-ended binding in `directory`; any broken `on` file throws (see `readOnBindings`). */
export async function readRunEndedBindings(directory: string): Promise<RunEndedBinding[]> {
  return (await readOnBindings(directory)).filter(binding => 'runEnded' in binding);
}

/** Every asks-settled binding in `directory`; any broken `on` file throws. */
export async function readAsksSettledBindings(directory: string): Promise<AsksSettledBinding[]> {
  return (await readOnBindings(directory)).filter(binding => 'asksSettled' in binding);
}

/** One trigger file as a binding with `on`, or undefined when it has none. */
async function readOnFile(file: string): Promise<OnBinding | undefined> {
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
  // The schema holds exactly one of the two.
  if (on.runEnded) return { file, sourceInstanceId, binding, runEnded: on.runEnded };
  if (on.asksSettled) return { file, sourceInstanceId, binding, asksSettled: on.asksSettled };
  throw new TriggerFileError(
    `Trigger file ${file} is invalid: on has neither runEnded nor asksSettled`
  );
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
  const values = outcomeValues(form);
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

/**
 * What a binding's inputs read from: the run's own inputs and result, for a run-ended
 * binding the key of the run's item, for an asks-settled binding the settled answers, and
 * the item's answers when a binding reads them. `gone` names why the run's inputs and
 * result cannot be read (its row was deleted), so a binding that reads them starts
 * nothing; the answers belong to the item and outlive the run.
 */
export type MappedSources =
  | {
      inputs: Readonly<Record<string, JsonValue>>;
      result: JsonValue | undefined;
      itemKey?: string;
      answers?: JsonValue;
      itemAnswers?: ItemAnswers;
    }
  | { gone: string; answers?: JsonValue; itemAnswers?: ItemAnswers };

type BindingInputSource = RunEndedInputSource | AsksSettledInputSource;

/** The target inputs a binding maps, or the first that did not resolve. */
export function mappedInputs(
  sources: Readonly<Record<string, BindingInputSource>> | undefined,
  from: MappedSources
): { inputs: Record<string, JsonValue> } | { missing: string } {
  const inputs: Record<string, JsonValue> = {};
  for (const [target, source] of Object.entries(sources ?? {})) {
    const value = mappedValue(source, from);
    if (typeof value === 'string') return { missing: `Input '${target}': ${value}` };
    // A declared input the run was not given passes nothing; the target's own
    // declaration decides at preparation whether that start can run.
    if (value.value !== undefined) inputs[target] = value.value;
  }
  return { inputs };
}

/** One source's value, possibly nothing, or why it cannot be read. */
function mappedValue(
  source: BindingInputSource,
  from: MappedSources
): { value: JsonValue | undefined } | string {
  // `{answers}` parses only in an asks-settled binding, which always passes them.
  if ('answers' in source)
    return from.answers === undefined ? 'there are no answers to read' : { value: from.answers };
  if (readsItemAnswers(source)) {
    if (from.itemAnswers === undefined) return 'there are no item answers to read';
    return 'unreadable' in from.itemAnswers
      ? from.itemAnswers.unreadable
      : { value: from.itemAnswers.entries };
  }
  if ('gone' in from) return from.gone;
  // `{item: 'key'}` parses only in a run-ended binding, which always passes the key.
  if ('item' in source)
    return from.itemKey === undefined ? 'there is no item key to read' : { value: from.itemKey };
  if ('input' in source) return { value: from.inputs[source.input] };
  const value =
    from.result === undefined ? undefined : resolveJsonPointer(from.result, source.result);
  return value === undefined ? `result pointer '${source.result}' did not resolve` : { value };
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
   * The checkout the ended run left, for a binding with `checkout: "ended-run"` (or, at
   * the completion of an asking run, `checkout: "asking-run"`). Read at most once per
   * completion, and only when such a binding matches.
   */
  endedCheckout: (run: WorkflowRun) => Promise<EndedCheckout>;
  /**
   * Every ask on an item, oldest first, for a binding that reads `{item: 'answers'}`. Read
   * at most once per completion, and only when such a binding matches.
   */
  listItemAsks: (itemId: string) => Promise<AttentionRead<StoredItemAsk>[]>;
  now?: () => Date;
}

/**
 * The starts the completion of `ended` causes. Only a run on an item causes starts (a
 * `workflow:` child is created with no item). A binding matches when it names the run's
 * workflow and outcome and launches in the item's project. Each match on the same item
 * gets its own receipt, keyed by the binding's source and the ended run, so a replayed
 * completion could never start it twice even if it reached the store. A match with
 * `linked` becomes a linked start, which the completing write turns into a receipt on
 * each item linked to this one.
 */
export function createRunEndedStarts(
  dependencies: RunEndedStartsDependencies
): (ended: RunEndedFacts) => Promise<RunEndedStarts> {
  return async ended => {
    const { run } = ended;
    const none = { receipts: [], linked: [] };
    if (!run.item_id) return none;
    const candidates = (await readRunEndedBindings(dependencies.triggersDirectory())).filter(
      candidate => candidate.runEnded.workflowName === run.workflow_name
    );
    if (candidates.length === 0) return none;
    const item = await dependencies.getItem(run.item_id);
    if (!item) throw new Error(`Run '${run.id}' names item '${run.item_id}', which is missing`);
    const receipts: SourceReceiptAcceptance[] = [];
    const linked: LinkedRunEndedStart[] = [];
    let checkout: Promise<EndedCheckout> | undefined;
    const endedCheckout = (): Promise<EndedCheckout> =>
      (checkout ??= dependencies.endedCheckout(run));
    let answers: Promise<ItemAnswers> | undefined;
    const answersOnItem = (): Promise<ItemAnswers> =>
      (answers ??= dependencies.listItemAsks(item.id).then(itemAnswers));
    for (const candidate of candidates) {
      const acceptance = await matchedReceipt(candidate, ended, item, dependencies, {
        endedCheckout,
        answersOnItem,
      });
      if (!acceptance) continue;
      const link = candidate.runEnded.linked;
      if (link) linked.push({ link, endedRunId: run.id, endedItemId: item.id, acceptance });
      else receipts.push(acceptance);
    }
    return { receipts, linked };
  };
}

/**
 * The receipt one binding writes for the end of `ended` on `item`, or undefined when the
 * binding is not about this end. Its problems throw naming the file.
 */
async function matchedReceipt(
  candidate: RunEndedBinding,
  ended: RunEndedFacts,
  item: WorkflowItem,
  dependencies: RunEndedStartsDependencies,
  read: {
    endedCheckout: () => Promise<EndedCheckout>;
    answersOnItem: () => Promise<ItemAnswers>;
  }
): Promise<SourceReceiptAcceptance | undefined> {
  // A binding that launches in another project is not about this item, even when a
  // workflow there has the same name.
  if ((await bindingProjectKey(candidate, dependencies)) !== item.projectKey) return undefined;
  const problems = runEndedBindingProblems(candidate.runEnded, ended);
  if (problems.length > 0)
    throw new Error(`Trigger file ${candidate.file}: ${problems.join('; ')}`);
  if (candidate.runEnded.outcome !== ended.outcome.value) return undefined;
  const readsAnswers = Object.values(candidate.runEnded.inputs ?? {}).some(readsItemAnswers);
  return bindingReceipt(
    candidate,
    { deliveryId: ended.run.id, sourceActor: runEndedActor(ended), itemKey: item.key },
    mappedInputs(candidate.runEnded.inputs, {
      ...ended,
      itemKey: item.key,
      ...(readsAnswers ? { itemAnswers: await read.answersOnItem() } : {}),
    }),
    candidate.runEnded.checkout === undefined ? undefined : await read.endedCheckout(),
    dependencies.now?.() ?? new Date()
  );
}

/** The source actor of a start a run's end caused: the run, and its outcome when it has one. */
function runEndedActor(ended: RunEndedFacts): NonNullable<SourceReceiptInput['sourceActor']> {
  return {
    source: RUN_ENDED_SOURCE_ACTOR,
    id: ended.run.id,
    ...(ended.outcome.value === '' ? {} : { display: ended.outcome.value }),
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
  candidate: OnBindingFile,
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

/**
 * The receipt one matched binding writes: matched with the mapped inputs as event inputs,
 * or unmatched naming the input that did not resolve or the checkout that was refused.
 * Keyed by the binding's source and `deliveryId` (the run the start is about), so a replay
 * never starts it twice. `checkout` is given only for a binding that takes another run's
 * checkout (`checkout: "ended-run"` or `checkout: "asking-run"`).
 */
export function bindingReceipt(
  candidate: OnBindingFile,
  delivery: {
    deliveryId: string;
    sourceActor: NonNullable<SourceReceiptInput['sourceActor']>;
    itemKey: string;
  },
  mapped: { inputs: Record<string, JsonValue> } | { missing: string },
  checkout: EndedCheckout | undefined,
  now: Date
): SourceReceiptAcceptance {
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
    deliveryId: delivery.deliveryId,
    contentDigest: createHash('sha256')
      .update(JSON.stringify(handoff && refused === undefined ? [content, handoff] : content))
      .digest('hex'),
    receivedAt: now.toISOString(),
    occurredAt: null,
    sourceActor: delivery.sourceActor,
    itemKey: delivery.itemKey,
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
export function declaredInputNames(workflow: Pick<ResolvedWorkflow, 'inputs' | 'pack'>): string[] {
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
  const started = selectStartedWorkflow(binding.launch, discovered);
  if (
    runEnded.checkout !== undefined &&
    'workflow' in started &&
    started.workflow.worktree?.enabled === false
  )
    problems.push(
      `workflow '${started.workflow.name}' runs in place (worktree.enabled: false), so it cannot take the ended run's checkout`
    );
  problems.push(...startedWorkflowProblems(started, runEnded.inputs));
  return problems;
}

/** The started workflow is the one a fire would start, and declares every input it maps. */
export function startedWorkflowProblems(
  started: StartedWorkflow,
  inputs: Readonly<Record<string, unknown>> | undefined
): string[] {
  if ('refused' in started) return [started.refused];
  const target = started.workflow;
  const declared = declaredInputNames(target);
  return Object.keys(inputs ?? {})
    .filter(name => !declared.includes(name))
    .map(name => `workflow '${target.name}' does not declare input '${name}'`);
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
    // A linked binding starts the stage on other items, so it never collides with a
    // same-item one, nor with a linked one of another kind or end.
    const stage = JSON.stringify([
      project,
      runEnded.workflowName,
      runEnded.outcome,
      binding.launch.workflowName,
      runEnded.linked ?? null,
    ]);
    stages.set(stage, [...(stages.get(stage) ?? []), index]);
    const found = await runEndedBindingCheck(candidate, deps);
    if (!runEnded.linked && binding.launch.workflowName === runEnded.workflowName)
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
  dependencies: Omit<RunEndedStartsDependencies, 'now' | 'endedCheckout' | 'listItemAsks'> &
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
