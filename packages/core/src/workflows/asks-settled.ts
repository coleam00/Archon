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
 * A binding with `checkout: "asking-run"` starts its stage in the checkout the asking run
 * left. That checkout is read when the asking run completes (`createAsksCheckout`) and
 * recorded on its row, and the completion keeps the run's worktree. When the asks settle,
 * the start is refused if that worktree is gone; otherwise preparation treats it as a
 * run-ended hand-off, which refuses a branch that moved off the recorded commit.
 */
import { existsSync } from 'node:fs';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { JsonValue } from '@archon/workflows/output-ref';
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
import { resolveWorkflowName } from '@archon/workflows/router';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
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

export interface AsksSettledStartsDependencies
  extends Omit<RunEndedStartsDependencies, 'endedCheckout'> {
  getItemAsk: (id: string) => Promise<StoredItemAsk | null>;
}

/** The row of the run that left the asks, as the settling transaction reads it; null when deleted. */
export interface AskingRunRow {
  metadata: Record<string, unknown>;
}

/**
 * Builds the receipts a settled set causes, inside the transaction that settles it: the
 * set's rows as they read after this close, and the run that left them. Synchronous, so
 * nothing slow runs while the set is locked. Throws when a binding could not be read,
 * which rolls the close back.
 */
export type AsksSettledReceipts = (
  rows: readonly StoredItemAsk[],
  run: AskingRunRow | null
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
    return (rows, run) => {
      const runId = rows[0]?.runId;
      if (runId === undefined) return [];
      const settledAs = rows.some(row => row.closed?.as === 'answered') ? 'answered' : 'withdrawn';
      const answers = rows.map(settledAnswer);
      const from =
        run === null
          ? { gone: `run '${runId}', which left the asks, no longer exists`, answers }
          : {
              inputs: readSubrunMetadata(run.metadata).inputs ?? {},
              result: readAsksResult(run.metadata),
              answers,
            };
      return candidates
        .filter(
          candidate =>
            candidate.asksSettled.settled === 'any' || candidate.asksSettled.settled === settledAs
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
  // worktree refuses here, where the reason lands on the receipt.
  if (recorded.worktree !== undefined && !existsSync(recorded.worktree))
    return {
      refused: `the worktree run '${runId}' left at '${recorded.worktree}' is gone, so its checkout cannot be handed over; ${again}`,
    };
  return { handoff: recorded.handoff };
}

/**
 * At the completion of a run on an item that leaves asks: the checkout it left, when an
 * asks-settled binding with `checkout` matches it (its workflow, in the item's project),
 * else undefined. Read once however many bindings match.
 */
export function createAsksCheckout(
  dependencies: Omit<RunEndedStartsDependencies, 'now'>
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
        return withWorktree(run, await dependencies.endedCheckout(run));
    return undefined;
  };
}

/**
 * A hand-off of the run's own branch names the worktree it left, so settling can tell
 * whether that checkout is still there. A run that worked on a copy hands on its source's
 * branch, which no worktree of its own holds.
 */
function withWorktree(run: WorkflowRun, checkout: EndedCheckout): AsksCheckout {
  return 'handoff' in checkout && checkout.handoff.runId === run.id && run.working_path
    ? { handoff: checkout.handoff, worktree: run.working_path }
    : checkout;
}

/**
 * One ask of a settled set as `{answers: true}` passes it: the question, how it closed, the
 * answer and the option it chose, and who closed it, through which surface and when.
 */
function settledAnswer(row: StoredItemAsk): JsonValue {
  const { closed } = row;
  // Unreachable: a replaced set can never settle, because a replaced ask cannot be closed.
  if (closed === null || closed.as === 'replaced')
    throw new Error(`Ask '${row.id}' is not answered or withdrawn in a settled set`);
  const option = closed.as === 'answered' ? chosenAskOption(row.ask, closed.answer) : undefined;
  return {
    question: row.ask.question,
    closedAs: closed.as,
    answer: closed.as === 'answered' ? closed.answer : null,
    option: option ?? null,
    by: closed.act.by,
    via: closed.act.via,
    at: closed.act.at,
  };
}

/**
 * Every problem with an asks-settled binding, read against the workflows of the project it
 * launches in: the asking workflow exists, declares `returns.asks` and every input the
 * binding reads, and the started workflow exists and declares every input it maps. With
 * `checkout: "asking-run"`, neither workflow may be pinned in place.
 */
export async function asksSettledBindingCheck(
  { binding, asksSettled }: AsksSettledBinding,
  deps: Pick<WorkflowDeps, 'loadConfig' | 'providers'>
): Promise<string[]> {
  const discovered = await discoverWorkflowsWithConfig(
    binding.launch.discoveryCwd ?? binding.launch.cwd,
    deps.loadConfig,
    deps.providers
  );
  const workflows = discovered.workflows.map(found => found.workflow);
  return [
    ...askingWorkflowProblems(asksSettled, workflows),
    ...checkoutProblems(asksSettled, binding.launch.workflowName, workflows),
    ...startedWorkflowProblems(binding.launch.workflowName, asksSettled.inputs, workflows),
  ];
}

/** With `checkout`, both runs need a worktree: one to leave it, one to take it. */
function checkoutProblems(
  asksSettled: AsksSettledTrigger,
  started: string,
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
  const target = resolveWorkflowName(started, workflows);
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
 * input order: the check a run gets before it starts, a missing `launch.cwd`, and two files
 * that start the same stage for the same settlement. A binding that starts the workflow
 * whose asks settled is the intended use (the work runs again with the answers), so it is
 * not reported; the loop ends when a run leaves no asks.
 */
export async function asksSettledTriggerCheck(
  bindings: readonly AsksSettledBinding[],
  deps: Pick<WorkflowDeps, 'loadConfig' | 'providers'> &
    Pick<RunEndedStartsDependencies, 'projectKeyOf'>
): Promise<string[][]> {
  const problems: string[][] = [];
  const stages: string[][] = [];
  for (const candidate of bindings) {
    const { binding } = candidate;
    if (!existsSync(binding.launch.cwd)) {
      problems.push([
        `binding.launch.cwd '${binding.launch.cwd}' does not exist, so this binding never starts; fix the path or remove the file`,
      ]);
      stages.push([]);
      continue;
    }
    const project = (await bindingProjectKey(candidate, deps)) ?? binding.launch.cwd;
    stages.push(stageKeys(candidate, project));
    problems.push(await asksSettledBindingCheck(candidate, deps));
  }
  for (const [index, others] of sharingFiles(bindings, stages).entries())
    if (others.length > 0)
      problems[index].push(
        `binds the same settlement to the same stage as ${others.join(', ')}: the stage starts once per file on the item`
      );
  return problems;
}

/** The stages a binding starts, one per kind of settlement it matches (`any` matches both). */
function stageKeys({ binding, asksSettled }: AsksSettledBinding, project: string): string[] {
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
  dependencies: Omit<RunEndedStartsDependencies, 'now' | 'endedCheckout'> &
    Pick<WorkflowDeps, 'loadConfig' | 'providers'>
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
      const problems = await asksSettledBindingCheck(candidate, dependencies);
      if (problems.length > 0)
        throw new Error(`Trigger file ${candidate.file}: ${problems.join('; ')}`);
    }
  };
}
