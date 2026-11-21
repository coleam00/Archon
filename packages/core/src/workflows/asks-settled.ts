/**
 * Asks-settled bindings: a trigger file in `ARCHON_HOME/triggers/` with `on.asksSettled`
 * starts its binding on the same item when the asks a run of the named workflow left there
 * are settled, every one answered or withdrawn. The receipts built here are written by the
 * write that settles the set, so a start exists exactly when the settlement does, and then
 * go through the one start path a run-ended binding's do: preparation, admission, capacity
 * and the item.
 *
 * The files are the ones run-ended bindings live in, read the same way (`readOnBindings`),
 * fresh at every close of an ask, so removing a file turns it off.
 *
 * A binding with `option` starts only when every answered ask of the set chose that option
 * (`choseOption`), so the options of one ask can each lead to a different stage, or to none.
 *
 * A binding with `checkout: "asking-run"` starts its stage in the checkout the asking run
 * left. That checkout is read when the asking run completes (`createAsksCheckout`) and
 * recorded on its row, and the completion keeps the run's worktree. When the asks settle,
 * the start is refused if that worktree is gone; otherwise preparation treats it as a
 * run-ended hand-off, which refuses a branch that moved off the recorded commit.
 */
import { existsSync } from 'node:fs';
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { chosenAskOption, type StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  readAsksCheckout,
  type AsksCheckout,
  type AsksSettledTrigger,
  type EndedCheckout,
  type SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { readAsksResult, readSubrunMetadata } from '@archon/workflows/schemas/run-metadata';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { discoverBindingWorkflows, type BindingDefinitionsDeps } from './definition-source';
import {
  bindingProjectKey,
  bindingReceipt,
  declaredInputNames,
  mappedInputs,
  readAsksSettledBindings,
  startedWorkflowProblems,
  type AsksSettledBinding,
  type RunEndedStartsDependencies,
} from './run-ended';
import { selectStartedWorkflow, type StartedWorkflow } from './binding-workflow';
import { itemAnswers, settledAnswer } from './item-answers';

export interface AsksSettledStartsDependencies
  extends Omit<RunEndedStartsDependencies, 'endedCheckout' | 'listItemAsks'> {
  getItemAsk: (id: string) => Promise<StoredItemAsk | null>;
}

/** The row of the run that left the asks, as the settling transaction reads it; null when deleted. */
export interface AskingRunRow {
  metadata: Record<string, unknown>;
}

/**
 * Builds the receipts a settled set causes, inside the transaction that settles it: the
 * set's rows as they read after this close, the run that left them, and every ask on the
 * item, this close included. Synchronous, so nothing slow runs while the set is locked.
 * Throws when a binding could not be read, which rolls the close back.
 */
export type AsksSettledReceipts = (
  rows: readonly StoredItemAsk[],
  run: AskingRunRow | null,
  itemAsks: readonly AttentionRead<StoredItemAsk>[]
) => SourceReceiptAcceptance[];

/**
 * Before a close: what its settlement would start. Every close reads its bindings, not only
 * the one that looks last from outside, because a concurrent close can make this one the
 * last and only the transaction can tell. A broken file or a project that does not resolve
 * refuses only a close that settles its set, naming why; any other close goes ahead.
 * Undefined when nothing could be started.
 */
export function createAsksSettledStarts(
  dependencies: AsksSettledStartsDependencies
): (askId: string) => Promise<AsksSettledReceipts | undefined> {
  return async askId => {
    let candidates: AsksSettledBinding[];
    let itemKey: string;
    try {
      const ask = await dependencies.getItemAsk(askId);
      if (!ask) return undefined;
      const named = (await readAsksSettledBindings(dependencies.triggersDirectory())).filter(
        candidate => candidate.asksSettled.workflowName === ask.workflowName
      );
      if (named.length === 0) return undefined;
      const item = await dependencies.getItem(ask.itemId);
      if (!item) throw new Error(`Ask '${askId}' names item '${ask.itemId}', which is missing`);
      itemKey = item.key;
      candidates = [];
      // A binding that launches in another project is not about this item.
      for (const candidate of named)
        if ((await bindingProjectKey(candidate, dependencies)) === item.projectKey)
          candidates.push(candidate);
    } catch (error) {
      return () => {
        throw error;
      };
    }
    if (candidates.length === 0) return undefined;
    const now = dependencies.now?.() ?? new Date();
    return (rows, run, itemAsks) => {
      const runId = rows[0]?.runId;
      if (runId === undefined) return [];
      const settledAs = rows.some(row => row.closed?.as === 'answered') ? 'answered' : 'withdrawn';
      const answers = rows.map(settledAnswer);
      const onItem = itemAnswers(itemAsks);
      const from =
        run === null
          ? {
              gone: `run '${runId}', which left the asks, no longer exists`,
              answers,
              itemAnswers: onItem,
            }
          : {
              inputs: readSubrunMetadata(run.metadata).inputs ?? {},
              result: readAsksResult(run.metadata),
              answers,
              itemAnswers: onItem,
            };
      return candidates
        .filter(({ asksSettled: { settled, option } }) =>
          option === undefined
            ? settled === 'any' || settled === settledAs
            : choseOption(rows, option)
        )
        .map(candidate =>
          bindingReceipt(
            candidate,
            {
              deliveryId: runId,
              sourceActor: { source: ASKS_SETTLED_SOURCE_ACTOR, id: runId, display: settledAs },
              itemKey,
            },
            mappedInputs(candidate.asksSettled.inputs, from),
            candidate.asksSettled.checkout === undefined
              ? undefined
              : recordedCheckout(runId, run, candidate.asksSettled.workflowName),
            now
          )
        );
    };
  };
}

/**
 * Whether a settled set chose `option`: at least one ask was answered, and every answered
 * ask chose that declared option id. Withdrawn asks are not counted; a mixed set, or an
 * answer that chose no offered option, did not choose it.
 */
function choseOption(rows: readonly StoredItemAsk[], option: string): boolean {
  const chosen = rows.flatMap(({ ask, closed }) =>
    closed?.as === 'answered' ? [chosenAskOption(ask, closed.answer)?.id] : []
  );
  return chosen.length > 0 && chosen.every(id => id === option);
}

/** The checkout the asking run recorded when it completed, or why a start cannot take one. */
function recordedCheckout(
  runId: string,
  run: AskingRunRow | null,
  workflowName: string
): EndedCheckout {
  const again = `run '${workflowName}' again on the item`;
  if (run === null)
    return { refused: `run '${runId}', which left the asks, no longer exists; ${again}` };
  const recorded = readAsksCheckout({ id: runId, metadata: run.metadata });
  if (recorded === undefined)
    return {
      refused: `run '${runId}' recorded no checkout when it ended (the binding's checkout was added after it ended, or an older Archon ran it); ${again}`,
    };
  if (!('handoff' in recorded)) return recorded;
  // Branch recreation would hand on a checkout the asking run no longer has, so a removed
  // worktree refuses here, where the reason lands on the receipt. Execution checks again
  // (`assertAskingWorktree`), for a start that runs later.
  const gone = askingWorktreeGone(runId, recorded);
  return gone === undefined ? { handoff: recorded.handoff } : { refused: `${gone}; ${again}` };
}

/** Why a recorded asks hand-off's worktree can no longer be handed over, or undefined. */
export function askingWorktreeGone(
  runId: string,
  recorded: Extract<AsksCheckout, { handoff: unknown }>
): string | undefined {
  return existsSync(recorded.worktree)
    ? undefined
    : `the worktree at '${recorded.worktree}' that holds the checkout run '${runId}' left is gone, so it cannot be handed over`;
}

/**
 * At the completion of a run on an item that leaves asks: the checkout it left, when an
 * asks-settled binding with `checkout` matches it (its workflow, in the item's project),
 * else undefined. Read once however many bindings match.
 */
export function createAsksCheckout(
  dependencies: Omit<RunEndedStartsDependencies, 'now' | 'listItemAsks'> & {
    getRun: (id: string) => Promise<WorkflowRun | null>;
  }
): (run: WorkflowRun) => Promise<AsksCheckout | undefined> {
  return async run => {
    if (!run.item_id) return undefined;
    const candidates = (await readAsksSettledBindings(dependencies.triggersDirectory())).filter(
      candidate =>
        candidate.asksSettled.workflowName === run.workflow_name &&
        candidate.asksSettled.checkout !== undefined
    );
    if (candidates.length === 0) return undefined;
    const item = await dependencies.getItem(run.item_id);
    if (!item) throw new Error(`Run '${run.id}' names item '${run.item_id}', which is missing`);
    for (const candidate of candidates)
      if ((await bindingProjectKey(candidate, dependencies)) === item.projectKey)
        return withWorktree(run, await dependencies.endedCheckout(run), dependencies.getRun);
    return undefined;
  };
}

/**
 * The hand-off with the worktree that holds it, so settling and execution can tell whether
 * that checkout is still there: the run's own, or for a run that worked on a copy, the one
 * its source run left. A source whose worktree is unknown or already gone is refused now.
 */
async function withWorktree(
  run: WorkflowRun,
  checkout: EndedCheckout,
  getRun: (id: string) => Promise<WorkflowRun | null>
): Promise<AsksCheckout> {
  if (!('handoff' in checkout)) return checkout;
  const { handoff } = checkout;
  const holder = handoff.runId === run.id ? run : await getRun(handoff.runId);
  const worktree = holder?.working_path;
  if (!worktree)
    return {
      refused: `run '${handoff.runId}', whose checkout run '${run.id}' worked on, has no recorded worktree`,
    };
  const recorded = { handoff, worktree };
  const gone = askingWorktreeGone(run.id, recorded);
  return gone === undefined ? recorded : { refused: gone };
}

/**
 * Every problem with an asks-settled binding, read against the workflows of the project it
 * launches in: the asking workflow exists, declares `returns.asks` and every input the
 * binding reads, and the started workflow exists and declares every input it maps. With
 * `checkout: "asking-run"`, neither workflow may be pinned in place.
 */
export async function asksSettledBindingCheck(
  { binding, asksSettled }: AsksSettledBinding,
  deps: BindingDefinitionsDeps,
  /** The run starting now whose end or asks may fire the binding; see `discoverBindingWorkflows`. */
  launchRun?: Pick<WorkflowRun, 'metadata'>
): Promise<string[]> {
  const read = await discoverBindingWorkflows(binding.launch, deps, launchRun);
  if ('refused' in read) return [read.refused];
  const { discovered } = read;
  const workflows = discovered.workflows.map(found => found.workflow);
  const started = selectStartedWorkflow(binding.launch, discovered);
  return [
    ...askingWorkflowProblems(asksSettled, workflows),
    ...checkoutProblems(asksSettled, started, workflows),
    ...startedWorkflowProblems(started, asksSettled.inputs),
  ];
}

/** With `checkout`, both runs need a worktree: one to leave it, one to take it. */
function checkoutProblems(
  asksSettled: AsksSettledTrigger,
  started: StartedWorkflow,
  workflows: readonly ResolvedWorkflow[]
): string[] {
  if (asksSettled.checkout === undefined) return [];
  const problems: string[] = [];
  // A folder project leaves no worktree either; that is known only when a start is
  // prepared, which refuses it then, naming it.
  const asking = workflows.find(workflow => workflow.name === asksSettled.workflowName);
  if (asking?.worktree?.enabled === false)
    problems.push(
      `workflow '${asking.name}' runs in place (worktree.enabled: false), so it leaves no checkout for checkout: asking-run`
    );
  const target = 'workflow' in started ? started.workflow : undefined;
  if (target?.worktree?.enabled === false)
    problems.push(
      `workflow '${target.name}' runs in place (worktree.enabled: false), so it cannot take the asking run's checkout`
    );
  return problems;
}

function askingWorkflowProblems(
  asksSettled: AsksSettledTrigger,
  workflows: readonly ResolvedWorkflow[]
): string[] {
  // Asks are opened under the run's own workflow name, so this matches it exactly.
  const asking = workflows.find(workflow => workflow.name === asksSettled.workflowName);
  if (!asking) return [`workflow '${asksSettled.workflowName}' is not in this project`];
  if (asking.result?.asks === undefined)
    return [`workflow '${asksSettled.workflowName}' declares no returns.asks`];
  const declared = declaredInputNames(asking);
  return Object.entries(asksSettled.inputs ?? {}).flatMap(([target, source]) =>
    'input' in source && !declared.includes(source.input)
      ? [
          `input '${target}' reads '${source.input}', which '${asksSettled.workflowName}' does not declare`,
        ]
      : []
  );
}

/**
 * What `trigger check` prints for asks-settled bindings, one problems list per binding in
 * input order: the check a run gets before it starts, a missing `launch.cwd`, two files
 * that start the same stage for the same settlement, and two files that would both start
 * when one option is chosen (`optionOverlaps`). A binding that starts the workflow
 * whose asks settled is the intended use (the work runs again with the answers), so it is
 * not reported; the loop ends when a run leaves no asks.
 */
export async function asksSettledTriggerCheck(
  bindings: readonly AsksSettledBinding[],
  deps: BindingDefinitionsDeps & Pick<RunEndedStartsDependencies, 'projectKeyOf'>
): Promise<string[][]> {
  const problems: string[][] = [];
  const stages: string[][] = [];
  const projects: (string | null)[] = [];
  for (const candidate of bindings) {
    const { binding } = candidate;
    if (!existsSync(binding.launch.cwd)) {
      problems.push([
        `binding.launch.cwd '${binding.launch.cwd}' does not exist, so this binding never starts; fix the path or remove the file`,
      ]);
      stages.push([]);
      projects.push(null);
      continue;
    }
    const project = (await bindingProjectKey(candidate, deps)) ?? binding.launch.cwd;
    stages.push(stageKeys(candidate, project));
    projects.push(project);
    problems.push(await asksSettledBindingCheck(candidate, deps));
  }
  for (const [index, others] of sharingFiles(bindings, stages).entries())
    if (others.length > 0)
      problems[index].push(
        `binds the same settlement to the same stage as ${others.join(', ')}: the stage starts once per file on the item`
      );
  for (const [index, overlaps] of optionOverlaps(bindings, projects).entries())
    problems[index].push(...overlaps);
  return problems;
}

/**
 * For each binding, the other files in its project on the same asking workflow that would
 * also start when an option it starts on is chosen, whatever stage each starts: a file
 * naming the same option, or one naming none that takes answers beside one that names it.
 * Two files naming no option are left to `stageKeys`, since several stages may start on
 * one settlement on purpose. A binding whose project is null is not compared.
 */
export function optionOverlaps(
  bindings: readonly AsksSettledBinding[],
  projects: readonly (string | null)[]
): string[][] {
  const takesAnswers = ({ asksSettled }: AsksSettledBinding): boolean =>
    asksSettled.settled !== 'withdrawn';
  return bindings.map((own, index) =>
    bindings.flatMap((other, at) => {
      if (at === index || projects[index] === null || projects[index] !== projects[at]) return [];
      if (own.asksSettled.workflowName !== other.asksSettled.workflowName) return [];
      const mine = own.asksSettled.option;
      const theirs = other.asksSettled.option;
      const option = mine ?? theirs;
      if (option === undefined || (mine !== undefined && theirs !== undefined && mine !== theirs))
        return [];
      if (!takesAnswers(own) || !takesAnswers(other)) return [];
      return [
        `starts when option '${option}' is chosen, as ${other.file} also does: both start on that answer`,
      ];
    })
  );
}

/**
 * The stages a binding names no option for, one per kind of settlement it matches (`any`
 * matches both). A binding with `option` is compared by `optionOverlaps` instead.
 */
function stageKeys({ binding, asksSettled }: AsksSettledBinding, project: string): string[] {
  if (asksSettled.option !== undefined) return [];
  const kinds = asksSettled.settled === 'any' ? ['answered', 'withdrawn'] : [asksSettled.settled];
  return kinds.map(kind =>
    JSON.stringify([project, asksSettled.workflowName, kind, binding.launch.workflowName])
  );
}

/** For each binding, the files of the others that start one of the same stages. */
function sharingFiles(
  bindings: readonly AsksSettledBinding[],
  stages: readonly string[][]
): string[][] {
  return stages.map((own, index) =>
    bindings
      .filter((_, other) => other !== index && stages[other].some(key => own.includes(key)))
      .map(other => other.file)
  );
}

/**
 * The check a run on an item gets before it starts, for the asks it may leave: every
 * asks-settled binding for its workflow in its project is checked in full, so a binding
 * that names a missing stage is refused before the run does any work, not when its asks
 * are answered.
 */
export function createAsksSettledPreflight(
  dependencies: Omit<RunEndedStartsDependencies, 'now' | 'endedCheckout' | 'listItemAsks'> &
    BindingDefinitionsDeps
): (run: WorkflowRun) => Promise<void> {
  return async run => {
    if (!run.item_id) return;
    const candidates = (await readAsksSettledBindings(dependencies.triggersDirectory())).filter(
      candidate => candidate.asksSettled.workflowName === run.workflow_name
    );
    if (candidates.length === 0) return;
    const item = await dependencies.getItem(run.item_id);
    if (!item) throw new Error(`Run '${run.id}' names item '${run.item_id}', which is missing`);
    for (const candidate of candidates) {
      if ((await bindingProjectKey(candidate, dependencies)) !== item.projectKey) continue;
      // Checked against the definitions this run executes.
      const problems = await asksSettledBindingCheck(candidate, dependencies, run);
      if (problems.length > 0)
        throw new Error(`Trigger file ${candidate.file}: ${problems.join('; ')}`);
    }
  };
}
