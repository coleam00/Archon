/**
 * Workflow command - list and run workflows
 */

import { checkoutSharedEventDataSchema } from '@archon/workflows/schemas/workflow-event';
import { getTerminalRecord } from '@archon/workflows/terminal-record';
import { loadConfig } from '@archon/core/config/config-loader';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { WorkflowResourceBusyError } from '@archon/workflows/store';
import type { DashboardWorkflowRun } from '@archon/workflows/schemas/workflow-run-listing';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import {
  WORKFLOW_EVENT_TYPES,
  isDurableWorkflowEventType,
  type WorkflowEventType,
} from '@archon/workflows/store';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { waitForRunAttention } from '@archon/core/services/run-attention-watch';
import type { RunWaitResult } from '@archon/core/services/run-attention-watch';
import { resolveWorkflowName } from '@archon/workflows/router';
import { workflowSourceConfigFrom } from '@archon/workflows/run-source';
import { formatFixtureReport, runFixtures } from '@archon/workflows/fixture-runner';
import type { WorkflowLoadError, WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import { workflowRunStatusSchema, runAttention } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import {
  CancelRefusedError,
  type CancelWorkflowResult,
  describeAbandonOwner,
  describeReleasedWorktrees,
  assertAnswerAdmissible,
  assertResponseAccepted,
  expectedGateForOccurrence,
  type ApprovalOperationResult,
  type GateAnswerOrigin,
} from '@archon/core/operations/workflow-operations';
import { attentionQueueSource } from '@archon/core/operations/attention-queue';
import {
  countAttentionQueue,
  listAttentionQueue,
  parseAttentionLabelPairs,
  parseAttentionQueueRequest,
  readAttentionQueueItem,
  selectAttentionQueue,
} from '@archon/workflows/attention-queue';
import {
  loadWorkflows,
  projectWorkflowDescription,
  WORKFLOW_DESCRIPTION_TRUNCATION_MARKER,
  type WorkflowJsonEntry,
} from './workflow-list';
import {
  buildNodeSummaries,
  fetchVerboseEvents,
  listRunEvents,
  printVerboseNodes,
  withRunDetail,
} from './workflow-node-summaries';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';
import {
  formatAge,
  getLog,
  printJsonWriteError,
  resolveDiscoveryCwdForCodebase,
  resolveRunIdArg,
  resolveRunTranscriptPath,
  spelledForCli,
} from './workflow-shared';
import {
  TRANSCRIPT_POLL_INTERVAL_MS,
  type TranscriptFormat,
  type TranscriptReadState,
  transcriptOutput,
  drainTranscript,
  finishTranscriptDecode,
  transcriptUnavailableMessage,
} from './workflow-transcript';
import {
  usageLimitWaitLine,
  formatToolAttention,
  formatWaitOutcome,
  announceWaitAttached,
  type LeaveBehind,
  buildLeaveBehind,
  readParseWarningEvents,
  printRunDetail,
} from './workflow-inspect';
import {
  type WorkflowAttentionOptions,
  resolveAttentionRunId,
  attentionScope,
  printAttentionItem,
  workflowAttentionWatch,
} from './workflow-attention';
import { runDetachedControlCommand } from './workflow-detach';
import { assertResumeWorkingPathExists } from './workflow-isolation';
import { workflowRunCommand } from './workflow-run-owned';

export interface WorkflowListOptions {
  json?: boolean;
  name?: string;
  full?: boolean;
}

export class WorkflowListLookupError extends Error {
  readonly loadErrors: readonly WorkflowLoadError[];

  constructor(message: string, loadErrors: readonly WorkflowLoadError[]) {
    super(message);
    this.name = 'WorkflowListLookupError';
    this.loadErrors = loadErrors;
  }
}

/**
 * Run every declared dry-run fixture and report per-fixture pass/fail (#2772).
 *
 * Read-only by construction — the only execution path is `dryRunWorkflow`, so no
 * run state is created and no provider is contacted. Returns the process exit code:
 * 0 when everything passes (including the nothing-declared case), 1 when any fixture
 * fails, a workflow cannot load, or an explicitly named target has none.
 */
export async function workflowTestCommand(
  invokingCwd: string,
  target: string | undefined,
  options: { json?: boolean } = {}
): Promise<number> {
  const { resolveDiscoveryCwd } = await import('../utils/project-cwd');
  const cwd = await resolveDiscoveryCwd(invokingCwd);
  const { workflows, errors } = await loadWorkflows(cwd);
  // The fixture runner freezes this repo's source before executing anything, exactly as
  // `workflow run` does, and this config decides which directories get frozen. A malformed
  // one would silently narrow that set, so it fails here instead; `loadConfig` returns
  // defaults when there is simply no config file.
  const config = await loadConfig(cwd).catch((error: unknown) => {
    throw new Error(
      `Cannot read the workflow source configuration in ${cwd}: ${(error as Error).message}`
    );
  });
  let report: Awaited<ReturnType<typeof runFixtures>>;
  try {
    report = await runFixtures({
      workflows,
      cwd,
      targetCwd: invokingCwd,
      sourceConfig: workflowSourceConfigFrom(config),
      ...(target !== undefined ? { target } : {}),
    });
  } catch (error) {
    if (errors.length === 0) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      await writeJsonLine({
        ok: false,
        error: message,
        errors: errors.map(e => ({
          filename: e.filename,
          error: e.error,
          errorType: e.errorType,
        })),
      });
    } else {
      let output = `Error: ${message}\n`;
      if (errors.length > 0) {
        output += `\n${errors.length} workflow(s) failed to load:\n\n`;
        for (const loadError of errors) {
          output += `  ${loadError.filename}: ${loadError.error}\n`;
        }
      }
      await writeStdout(output);
    }
    return 1;
  }

  if (options.json) {
    await writeJsonLine({
      results: report.results.map(r => ({
        ...r,
        missingStubs: [...r.missingStubs],
        toleratedMissingStubs: [...r.toleratedMissingStubs],
        unusedStubs: [...r.unusedStubs],
      })),
      passed: report.passed,
      failed: report.failed,
      errors: errors.map(e => ({
        filename: e.filename,
        error: e.error,
        errorType: e.errorType,
      })),
    });
  } else {
    let output = `${formatFixtureReport(report)}\n`;
    if (errors.length > 0) {
      output += `\n${errors.length} workflow(s) failed to load:\n\n`;
      for (const error of errors) {
        output += `  ${error.filename}: ${error.error}\n`;
      }
    }
    await writeStdout(output);
  }

  if (
    errors.length > 0 ||
    report.failed > 0 ||
    (target !== undefined && report.results.length === 0)
  ) {
    return 1;
  }
  return 0;
}

/**
 * List available workflows in the current directory
 */
export async function workflowListCommand(
  cwd: string,
  options: WorkflowListOptions = {}
): Promise<void> {
  const { workflows: workflowEntries, errors } = await loadWorkflows(cwd);
  let listedEntries = workflowEntries;
  if (options.name !== undefined) {
    let workflow: WorkflowWithSource['workflow'] | undefined;
    try {
      workflow = resolveWorkflowName(
        options.name,
        workflowEntries.map(entry => entry.workflow)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowListLookupError(message, errors);
    }
    if (workflow === undefined) {
      const availableWorkflows = workflowEntries
        .map(entry => `  - ${entry.workflow.name}`)
        .join('\n');
      throw new WorkflowListLookupError(
        `Workflow '${options.name}' not found.\n\nAvailable workflows:\n${availableWorkflows || '  (none)'}`,
        errors
      );
    }
    listedEntries = workflowEntries.filter(entry => entry.workflow.name === workflow.name);
  }

  if (options.json) {
    const output = {
      // `declared` rather than the expanded workflow: composition collapses these fields
      // onto the nodes and removes them (#1764), so the listing reports what the author
      // wrote. `webSearchMode` is the one that stays on the definition — it has no
      // per-node form to collapse onto.
      workflows: listedEntries.map(
        ({ workflow: w, parseWarnings, declared }): WorkflowJsonEntry => {
          const description = projectWorkflowDescription(w.description, options.full === true);
          const entry: WorkflowJsonEntry = {
            name: w.name,
            description: description.description,
            descriptionTruncated: description.truncated,
          };
          if (declared?.provider !== undefined) entry.provider = declared.provider;
          if (declared?.model !== undefined) entry.model = declared.model;
          if (declared?.effort !== undefined) entry.effort = declared.effort;
          if (w.webSearchMode !== undefined) entry.webSearchMode = w.webSearchMode;
          if (parseWarnings && parseWarnings.length > 0) entry.parseWarnings = [...parseWarnings];
          return entry;
        }
      ),
      errors: errors.map(e => ({
        filename: e.filename,
        error: e.error,
        errorType: e.errorType,
      })),
    };
    await writeJsonLine(output);
    return;
  }

  console.log(`Discovering workflows in: ${cwd}`);

  if (listedEntries.length === 0 && errors.length === 0) {
    console.log('\nNo workflows found.');
    console.log('Workflows should be in .archon/workflows/ directory.');
    return;
  }

  if (listedEntries.length > 0) {
    console.log(`\nFound ${listedEntries.length} workflow(s):\n`);

    for (const { workflow, parseWarnings, declared } of listedEntries) {
      const description = projectWorkflowDescription(workflow.description, options.full === true);
      console.log(`  ${workflow.name}`);
      console.log(
        `    ${description.description}${description.truncated ? WORKFLOW_DESCRIPTION_TRUNCATION_MARKER : ''}`
      );
      if (declared?.provider) {
        console.log(`    Provider: ${declared.provider}`);
      }
      for (const warning of parseWarnings ?? []) {
        console.log(`    Warning: ${warning}`);
      }
      console.log('');
    }
  }

  if (errors.length > 0) {
    console.log(`\n${errors.length} workflow(s) failed to load:\n`);
    for (const e of errors) {
      console.log(`  ${e.filename}: ${e.error}`);
    }
    console.log('');
  }
}

export { workflowRunCommand };

/** Show active workflow runs for the current project, or every project with `--all`. */
export async function workflowStatusCommand(
  host: WorkflowHost,
  cwd: string,
  opts: { json?: boolean; verbose?: boolean; rawEvents?: boolean; all?: boolean } = {}
): Promise<void> {
  const { getWorkflowStatus } = host.operations;

  let codebase = null;
  if (!opts.all) {
    try {
      codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, cwd }, 'cli.workflow_status_codebase_lookup_failed');
      throw new Error(`Failed to resolve workflow status project: ${err.message}`, { cause: err });
    }
  }

  let runs: DashboardWorkflowRun[];
  try {
    const result = await getWorkflowStatus(codebase ? { codebaseId: codebase.id } : undefined);
    runs = result.runs;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_status_failed');
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }

  const scopeFallback = !opts.all && !codebase;

  if (opts.json) {
    if (!opts.verbose) {
      await writeJsonLine({
        runs: runs.map(run => ({ ...run, attention: runAttention(run) })),
        scopeFallback,
      });
      return;
    }

    const fetchedPerRun = await Promise.all(
      runs.map(run => fetchVerboseEvents(host, run.id, opts.rawEvents ?? false))
    );
    const runsOutput = runs.map((run, i) => {
      const runEvents = fetchedPerRun[i]?.events ?? [];
      return opts.rawEvents
        ? { ...run, attention: runAttention(run), events: runEvents }
        : { ...run, attention: runAttention(run), nodes: buildNodeSummaries(runEvents) };
    });
    await writeJsonLine({ runs: runsOutput, scopeFallback });
    return;
  }

  if (scopeFallback) {
    console.log('(not a registered project — showing all runs)');
  }

  if (runs.length === 0) {
    console.log('No active workflows.');
    return;
  }

  console.log(`\nActive workflows (${runs.length}):\n`);
  for (const run of runs) {
    const age = formatAge(run.started_at);
    console.log(`  ID:     ${run.id}`);
    console.log(`  Name:   ${run.workflow_name}`);
    console.log(`  Path:   ${run.working_path ?? '(none)'}`);
    console.log(`  Status: ${run.status}`);
    const attention = runAttention(run);
    if (attention?.kind === 'stalled_tool_calls') console.log(formatToolAttention(attention));
    if (attention?.kind === 'usage_limit')
      console.log(usageLimitWaitLine(attention.nodeId, attention.resumeAt));
    if (run.outcome) console.log(`  Authored outcome: ${run.outcome}`);
    console.log(`  Age:    ${age}`);
    if (run.active_nodes.length > 0) {
      console.log(
        `  Active node${run.active_nodes.length === 1 ? '' : 's'}: ${run.active_nodes.join(', ')}`
      );
    }

    if (opts.verbose) {
      const { events, failed } = await fetchVerboseEvents(host, run.id, false);
      if (failed) {
        console.log('  (node events unavailable — see logs)');
      }
      printVerboseNodes(events);
    }

    console.log('');
  }
}

/**
 * Block until a run needs attention, loses its owner, or reaches the caller's deadline.
 *
 * The point of the verb: a host that launched a run with `--detach` waits on one
 * command instead of polling `workflow get`. Exit codes describe the COMMAND, not the
 * run — 0 the run said something, 3 the deadline passed with the run still live, 1 the
 * wait itself failed. A `failed` or `cancelled` run is still exit 0 with its status on
 * stdout; mapping run state onto the process exit code would make a legitimately
 * cancelled run look like a broken command.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowWaitCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string,
  timeoutSeconds?: number
): Promise<number> {
  let result: RunWaitResult;
  let resolvedId: string;
  try {
    resolvedId = await resolveRunIdArg(host, runId, cwd);
    result = await waitForRunAttention(host.deps.store, resolvedId, {
      doorbell: host.doorbell,
      // No timeout by default: a wait that ends on its own clock would answer a
      // question only the run can answer.
      ...(timeoutSeconds === undefined ? {} : { deadlineMs: timeoutSeconds * 1000 }),
      onAttached: (observedStatus, ownerLiveness) =>
        announceWaitAttached(resolvedId, observedStatus, json, ownerLiveness),
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_wait_failed');
    // In --json mode never throw — emit one parseable {ok:false} line (same contract
    // as `get` and the write commands) so a parsing agent always gets JSON.
    if (json) {
      await writeJsonLine({ ok: false, runId, action: 'wait', error: err.message });
      return 1;
    }
    throw new Error(`Failed to wait for workflow run: ${err.message}`);
  }

  if (result.kind === 'not_found') {
    if (json) {
      await writeJsonLine({ ok: false, runId, action: 'wait', error: 'not_found' });
    } else {
      console.log(formatWaitOutcome(resolvedId, result));
    }
    return 1;
  }

  if (json) {
    await writeJsonLine({
      ok: true,
      action: 'wait',
      runId: resolvedId,
      result: result.kind,
      ...(result.kind === 'attention' ? { attention: result.attention } : {}),
      ...(result.kind === 'deadline' || result.kind === 'owner_lost'
        ? { observedStatus: result.observedStatus }
        : {}),
    });
  } else {
    console.log(formatWaitOutcome(resolvedId, result));
  }

  // 3 keeps "the run is still live" distinguishable from both a real answer (0) and a
  // broken wait (1).
  return result.kind === 'deadline' ? 3 : 0;
}

/**
 * The attention queue as typed JSON for answerers outside Archon: the items in scope,
 * how many fall under each project or label value, or the one item a run stands for.
 * Read-only; answering goes through `answer`, `approve`, `reject` or `respond`.
 */
export async function workflowAttentionCommand(
  host: WorkflowHost,
  cwd: string,
  runId: string | undefined,
  opts: WorkflowAttentionOptions
): Promise<number> {
  try {
    if (opts.after !== undefined && !opts.watch)
      throw new Error('workflow attention --after needs --watch');
    if (opts.watch) {
      if (runId !== undefined || opts.sort !== undefined || opts.countBy !== undefined)
        throw new Error('workflow attention --watch takes no run id, --sort or --count-by');
      return await workflowAttentionWatch(host, cwd, opts);
    }
    const source = attentionQueueSource(host.deps.store, host.records.isolation);
    if (runId !== undefined) {
      if (
        opts.project !== undefined ||
        opts.all ||
        opts.labels.length > 0 ||
        opts.sort !== undefined ||
        opts.countBy !== undefined
      )
        throw new Error(
          'workflow attention <run-id> takes no --project, --all, --label, --sort or --count-by'
        );
      const resolvedId = await resolveAttentionRunId(host, runId, cwd);
      const item = await readAttentionQueueItem(source, resolvedId);
      if (item === undefined) {
        if (opts.json)
          await writeJsonLine({ ok: false, runId, action: 'attention', error: 'not_found' });
        else console.log(`Workflow run not found: ${runId}`);
        return 1;
      }
      if (opts.json) {
        await writeJsonLine({ ok: true, action: 'attention', runId: resolvedId, item });
      } else if (item === null) {
        console.log(`Run ${resolvedId} needs no attention now.`);
      } else {
        printAttentionItem(item);
      }
      return 0;
    }

    const { labels, order, countBy } = parseAttentionQueueRequest(opts);
    const scope = await attentionScope(host, cwd, opts);
    const items = await listAttentionQueue(source);

    if (countBy !== undefined) {
      const counts = countAttentionQueue(items, { scope, labels, countBy });
      if (opts.json) {
        await writeJsonLine({ ok: true, action: 'attention', scope, counts });
        return 0;
      }
      const rows =
        counts.by === 'project'
          ? counts.counts.map(
              entry => [entry.count, entry.project?.name ?? '(no project)'] as const
            )
          : counts.counts.map(
              entry => [entry.count, entry.value ?? `(no '${counts.key}' label)`] as const
            );
      for (const [count, name] of rows) console.log(`  ${String(count).padStart(4)}  ${name}`);
      if (rows.length === 0) console.log('No runs need attention.');
      return 0;
    }

    const selected = selectAttentionQueue(items, { scope, labels, order });
    if (opts.json) {
      await writeJsonLine({ ok: true, action: 'attention', scope, items: selected });
      return 0;
    }
    const where = scope.kind === 'all' ? 'this install' : `project ${scope.project.name}`;
    if (selected.length === 0) {
      console.log(`No runs need attention in ${where}.`);
      return 0;
    }
    console.log(`\n${String(selected.length)} run(s) need attention in ${where}:\n`);
    for (const item of selected) {
      printAttentionItem(item);
      console.log('');
    }
    return 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_attention_failed');
    if (opts.json) {
      await writeJsonLine({
        ok: false,
        ...(runId ? { runId } : {}),
        action: 'attention',
        error: err.message,
      });
      return 1;
    }
    throw new Error(`Failed to read the attention queue: ${err.message}`, { cause: err });
  }
}

/**
 * Merge a label write into the attention wait a run is paused at: `set` pairs replace
 * the same keys, `unset` keys are removed, nothing else changes. Refused when the run is
 * no longer at `occurrence`.
 */
export async function workflowAttentionLabelCommand(
  host: WorkflowHost,
  runId: string,
  occurrence: string,
  set: readonly string[],
  unset: readonly string[],
  json: boolean | undefined,
  cwd: string
): Promise<number> {
  try {
    const resolvedId = await resolveAttentionRunId(host, runId, cwd);
    const result = await host.operations.labelAttentionWait(
      resolvedId,
      { occurrence, set: parseAttentionLabelPairs(set), unset },
      { kind: 'operator' },
      'cli'
    );
    if (json) {
      await writeJsonLine({ ok: true, action: 'attention_label', ...result });
    } else {
      const labels = Object.entries(result.labels).map(([key, value]) => `${key}=${value}`);
      console.log(
        `Labeled run ${result.runId} at revision ${String(result.revision)}: ${
          labels.length > 0 ? labels.join(', ') : 'no labels'
        }`
      );
    }
    return 0;
  } catch (error) {
    if (!json) throw error;
    await printJsonWriteError(runId, 'attention_label', error);
    return 1;
  }
}

/** Print or follow one run's append-only JSONL transcript, verbatim or as text, without mutating the run. */
export async function workflowLogsCommand(
  host: WorkflowHost,
  runId: string,
  follow: boolean,
  cwd?: string,
  format: TranscriptFormat = 'jsonl'
): Promise<number> {
  let resolvedId = runId;
  try {
    resolvedId = await resolveRunIdArg(host, runId, cwd);
    let run = await host.deps.store.getWorkflowRun(resolvedId);
    if (!run) {
      await writeStderr(`Workflow run not found: ${runId}\n`);
      return 1;
    }

    const transcriptPath = await resolveRunTranscriptPath(host, run);
    if (!transcriptPath) {
      await writeStderr(`Transcript path is unavailable for workflow run ${run.id}.\n`);
      return 1;
    }

    const state: TranscriptReadState = {
      offset: 0,
      decoder: new TextDecoder(),
      output: transcriptOutput(format),
    };

    if (!follow) {
      const exists = await drainTranscript(transcriptPath, state);
      if (!exists || state.offset === 0) {
        await writeStderr(`${transcriptUnavailableMessage(run, transcriptPath, false)}\n`);
        return 1;
      }
      await finishTranscriptDecode(state);
      return 0;
    }

    await writeStderr(`Following transcript: ${transcriptPath}\n`);
    while (true) {
      await drainTranscript(transcriptPath, state);
      run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) throw new Error(`Workflow run disappeared while following it: ${resolvedId}`);

      if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        await drainTranscript(transcriptPath, state);
        if (state.offset === 0) {
          await writeStderr(`${transcriptUnavailableMessage(run, transcriptPath, true)}\n`);
          return 1;
        }
        await finishTranscriptDecode(state);
        return 0;
      }

      await new Promise<void>(resolvePoll => setTimeout(resolvePoll, TRANSCRIPT_POLL_INTERVAL_MS));
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId: resolvedId }, 'cli.workflow_logs_failed');
    await writeStderr(`Failed to read workflow transcript: ${err.message}\n`);
    return 1;
  }
}

/**
 * Show detail for a single workflow run by ID (any status).
 *
 * Unlike `status` (active runs only), this resolves one run regardless of
 * status — so an agent can answer "did the review pass?" for a completed/failed
 * run. `--verbose` adds the per-node summary; `--json` emits the raw run plus a
 * `nodes` array when verbose (`--events` selects raw event rows instead).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowGetCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  verbose?: boolean,
  cwd?: string,
  rawEvents?: boolean
): Promise<number> {
  let run: WorkflowRun | null;
  try {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    run = await host.deps.store.getWorkflowRun(resolvedId);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_get_failed');
    // In --json mode never throw — emit one parseable {ok:false} line (same
    // contract as the write commands) so a parsing agent always gets JSON.
    if (json) {
      await writeJsonLine({ ok: false, runId, error: err.message });
      return 1;
    }
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }

  if (!run) {
    // Not-found exits non-zero so `get <id> && ...` and CI checks see the
    // failure (the JSON envelope already carries ok:false for parsers).
    if (json) {
      await writeJsonLine({ ok: false, runId, error: 'not_found' });
    } else {
      console.log(`Workflow run not found: ${runId}`);
    }
    return 1;
  }

  // The terminal record is persisted in the event log, including for default get.
  let events: WorkflowEventRow[];
  let terminalRecord;
  try {
    events = await listRunEvents(host, run.id, rawEvents ?? false);
    terminalRecord = getTerminalRecord(run.status, events);
  } catch (error) {
    getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_get_events_failed');
    if (json) {
      await writeJsonLine({ ok: false, runId: run.id, error: 'workflow_events_unavailable' });
    } else {
      console.log(`Workflow run events unavailable: ${run.id} (see logs)`);
    }
    return 1;
  }

  // Leave-behind view (#2747): what did this run leave, and where. Assembled
  // from existing data — status/outcome, adoption chain, and its artifact file
  // list resolved through the persisted output_root (read-only by contract).
  let leaveBehind: LeaveBehind | undefined;
  try {
    leaveBehind = await buildLeaveBehind(host, run);
  } catch (error) {
    getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_get_leave_behind_failed');
  }

  let transcriptPath: string | null = null;
  try {
    transcriptPath = await resolveRunTranscriptPath(host, run);
  } catch (error) {
    getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_get_transcript_failed');
  }

  if (json) {
    if (!verbose) {
      await writeJsonLine({
        ...run,
        transcript_path: transcriptPath,
        terminal_record: terminalRecord,
        ...(leaveBehind ? { leave_behind: leaveBehind } : {}),
      });
      return 0;
    }

    const parseWarnings = readParseWarningEvents(events);
    const output = rawEvents
      ? {
          ...run,
          transcript_path: transcriptPath,
          terminal_record: terminalRecord,
          events,
        }
      : {
          ...run,
          transcript_path: transcriptPath,
          terminal_record: terminalRecord,
          nodes: buildNodeSummaries(events),
          // Keys the engine dropped from this run's YAML (#2213). Surfaced as a
          // named field rather than leaving the caller to scan raw events.
          ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
        };
    await writeJsonLine(output);
    return 0;
  }

  printRunDetail(run, { transcriptPath, terminalRecord, leaveBehind, events, verbose });
  return 0;
}

/**
 * List recent workflow runs for the current project (all statuses, cwd-scoped).
 *
 * Complements `status` (active-only): resolves the codebase from `cwd` the same
 * way `workflow run` does, then lists that project's recent runs of every
 * status. `--all` drops the project scope (lists across all projects);
 * `--status` filters to one status; `--limit` caps the count (default 20).
 * `--json --verbose` adds each run's `nodes` and `attention` (see `withRunDetail`).
 */
export async function workflowRunsCommand(
  host: WorkflowHost,
  cwd: string,
  opts: {
    json?: boolean;
    all?: boolean;
    status?: string;
    limit?: number;
    open?: boolean;
    verbose?: boolean;
  } = {}
): Promise<number> {
  // Open-work inbox (#2747): terminal failed runs nothing has adopted or
  // superseded — the operator's "what ended with work on the table" query.
  // Status-derived v1 semantics; --status/--open are mutually exclusive shapes.
  if (opts.open) {
    if (opts.status) {
      const msg = '--open and --status are mutually exclusive: the inbox is failed runs only.';
      if (opts.json) {
        await writeJsonLine({ ok: false, error: msg });
        return 1;
      }
      throw new Error(msg);
    }
    let codebase = null;
    if (!opts.all) {
      try {
        codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
      } catch (error) {
        getLog().warn({ err: error as Error, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
      }
    }
    const runs = await host.deps.store.findOpenWorkRuns({
      codebaseId: opts.all ? undefined : (codebase?.id ?? undefined),
      limit: opts.limit ?? 20,
    });
    if (opts.json) {
      await writeJsonLine({
        runs: opts.verbose ? await withRunDetail(host, runs) : runs,
        total: runs.length,
        scopeFallback: !opts.all && !codebase,
      });
      return 0;
    }
    if (runs.length === 0) {
      console.log('No open workflow runs — nothing ended with work on the table.');
      return 0;
    }
    console.log(`\nOpen work (${String(runs.length)}):\n`);
    for (const run of runs) {
      const outcome = run.outcome ? ` · authored outcome: ${run.outcome}` : '';
      console.log(
        `  ${run.id.slice(0, 8)}  ${run.workflow_name}${outcome}  (${formatAge(run.started_at)})  adopt: workflow run <name> --adopt ${run.id}`
      );
    }
    console.log('');
    return 0;
  }

  let statusFilter: WorkflowRunStatus | undefined;
  if (opts.status) {
    const parsed = workflowRunStatusSchema.safeParse(opts.status);
    if (!parsed.success) {
      const msg = `Invalid --status '${opts.status}'. Valid: ${workflowRunStatusSchema.options.join(', ')}.`;
      // --json never throws — emit one parseable {ok:false} line (write-command contract).
      if (opts.json) {
        await writeJsonLine({ ok: false, error: msg });
        return 1;
      }
      throw new Error(msg);
    }
    statusFilter = parsed.data;
  }

  // Scope to this project by exact registration first, then through the
  // checkout's canonical repository path. This preserves an explicitly
  // registered linked worktree while allowing another linked worktree to share
  // its registered primary checkout. Ordinary clones remain unchanged (#2613).
  // --all opts out of scoping. A lookup failure or an unregistered cwd both
  // fall back to the global list — never a silent wrong-scope (the human path
  // prints an explicit note below).
  let codebase = null;
  if (!opts.all) {
    try {
      codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
    } catch (error) {
      getLog().warn({ err: error as Error, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
    }
  }
  // listDashboardRuns ignores undefined filters (truthy-guarded WHERE clauses),
  // so pass codebaseId/status straight through — no conditional spread needed.
  const codebaseId = opts.all ? undefined : codebase?.id;

  let result;
  try {
    result = await host.deps.store.listWorkflowRuns({
      codebaseId,
      status: statusFilter,
      limit: opts.limit ?? 20,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_runs_failed');
    if (opts.json) {
      await writeJsonLine({ ok: false, error: err.message });
      return 1;
    }
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }

  // True when project scoping was requested but fell back to the global list
  // (unregistered cwd or a lookup failure). The human path prints a note below;
  // surface the same signal in --json so an agent isn't handed a global result
  // it silently mistakes for a project-scoped one.
  const scopeFallback = !opts.all && !codebase;

  if (opts.json) {
    if (!opts.verbose) {
      await writeJsonLine({ ...result, scopeFallback });
      return 0;
    }
    // An events-query failure propagates to the CLI's `{ok:false}` handler, as it does
    // on the `--open` path: runs with silently empty `nodes` would read as unstarted.
    await writeJsonLine({ ...result, runs: await withRunDetail(host, result.runs), scopeFallback });
    return 0;
  }

  if (scopeFallback) {
    console.log('(not a registered project — showing all runs)');
  }

  if (result.runs.length === 0) {
    console.log('No workflow runs found.');
    return 0;
  }

  console.log(`\nRecent runs (${result.runs.length} of ${result.total}):\n`);
  for (const run of result.runs) {
    const activeNodes =
      run.active_nodes.length > 0 ? ` · active node(s): ${run.active_nodes.join(', ')}` : '';
    const outcome = run.outcome ? ` · authored outcome: ${run.outcome}` : '';
    console.log(
      `  ${run.id.slice(0, 8)}  ${run.status.padEnd(9)}  ${run.workflow_name}${activeNodes}${outcome}  (${formatAge(run.started_at)})`
    );
  }
  console.log('');
  return 0;
}

/**
 * Resume a failed workflow run by ID.
 *
 * Re-executes the workflow with --resume semantics: `workflowRunCommand` locates
 * the prior failed run via findResumableRun and hands it to the executor, which
 * skips already-completed nodes (the executor no longer auto-detects on its own).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowResumeCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean
): Promise<number> {
  const { resumeWorkflow: resumeWorkflowOp } = host.operations;

  // --detach: validate read-only (resumeWorkflowOp checks the run is resumable),
  // then let a detached child re-invoke the blocking resume and own all mutation
  // + execution, so a reaped launching shell can't wedge the run mid-resume.
  // Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'resume', json, cwd, async () => {
      const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
      // The inline path below refuses a run with no recorded working path, or one
      // whose checkout is gone. Check both here too, on the run the precheck already
      // holds: otherwise the parent acks success and the child throws where nobody
      // reads it.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume. The run may be too old.'
        );
      }
      assertResumeWorkingPathExists(run.working_path);
      return run;
    });
  }

  // JSON mode is a non-blocking control-plane ack: validate the run is resumable
  // and report its state, but do NOT re-execute the workflow inline (execution
  // streams workflow output to stdout, which would corrupt the JSON contract).
  // To actually execute a resumable run, use the blocking `resume` (no --json,
  // run as a background task) or `resume <run-id> --detach`. Prefer that exact-id
  // form over `run <name> --resume --detach`, which selects the newest resumable
  // run of that workflow in the CURRENT checkout — a different question, and the
  // wrong one when the caller already holds a run id (#2645).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'resume',
        executed: false,
        status: run.status,
        workflowName: run.workflow_name,
        workingPath: run.working_path,
      });
    } catch (error) {
      await printJsonWriteError(runId, 'resume', error);
      return 1;
    }
    return 0;
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
  if (!run.working_path) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume. The run may be too old.'
    );
  }
  console.log(`Resuming workflow: ${run.workflow_name}`);
  console.log(`Path: ${run.working_path}`);
  console.log('');

  // Use the codebase's source path for workflow YAML discovery so the file is
  // found even when working_path is a worktree or workspace clone that does
  // not contain the user's local (often untracked) workflow YAML.
  const discoveryCwd = run.codebase_id
    ? await resolveDiscoveryCwdForCodebase(host, resolvedId, run.codebase_id, 'resume')
    : undefined;

  // Re-execute via workflowRunCommand with --resume: it locates the prior failed
  // run via findResumableRun and skips already-completed nodes (the executor
  // itself no longer auto-detects resumable runs).
  try {
    await workflowRunCommand(host, run.working_path, run.workflow_name, run.user_message ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: run,
      resume: true,
      codebaseId: run.codebase_id ?? undefined,
      discoveryCwd,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: run.workflow_name },
      'cli.workflow_resume_run_failed'
    );
    throw new Error(`Failed to resume workflow '${run.workflow_name}': ${err.message}`, {
      cause: err,
    });
  }
  return 0;
}

/**
 * Abandon a workflow run by ID (marks it as cancelled).
 *
 * `--json` emits a structured result instead of human text. In JSON mode the
 * command never throws — lookup/state errors are reported as `{ ok: false }` so
 * a parsing agent always gets one clean JSON line.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowAbandonCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const { abandonWorkflow } = host.operations;

  // The container reclaim (M2) and the live-owner stop both live in the shared
  // `abandonWorkflow` op, so EVERY surface does them — the CLI reports the outcome.
  // Keeps `--json` a clean one-line contract (no reclaim text before the payload).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const {
        run,
        cascadeFailures,
        cleanupWarnings,
        releasedWorktrees,
        blockedParentRunId,
        owner,
      } = await abandonWorkflow(resolvedId, { kind: 'operator' });
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'abandon',
        status: 'cancelled',
        workflowName: run.workflow_name,
        owner:
          owner.kind === 'stopped'
            ? { outcome: 'stopped', pid: owner.pid }
            : {
                outcome: 'no_owner_answered',
                thisHost: owner.thisHost,
                recordedHost: owner.recordedOwner?.host ?? null,
                recordedPid: owner.recordedOwner?.pid ?? null,
                recordedUid: owner.recordedOwner?.uid ?? null,
                lastActivityAt: owner.lastActivityAt?.toISOString() ?? null,
              },
        ...(releasedWorktrees ? { releasedWorktrees } : {}),
        ...(cleanupWarnings ? { cleanupWarnings } : {}),
        ...(cascadeFailures > 0 ? { cascadeFailures } : {}),
        ...(blockedParentRunId ? { blockedParentRunId } : {}),
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'abandon', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const { run, cascadeFailures, cleanupWarnings, releasedWorktrees, blockedParentRunId, owner } =
    await abandonWorkflow(resolvedId, { kind: 'operator' });
  for (const line of describeAbandonOwner(owner)) console.log(line);
  console.log(`Abandoned workflow run: ${resolvedId}`);
  console.log(`Workflow: ${run.workflow_name}`);
  for (const line of describeReleasedWorktrees(releasedWorktrees)) console.log(line);
  for (const warning of cleanupWarnings ?? []) console.log(`Warning: ${warning}`);
  printRunTreeCancellationWarnings(cascadeFailures, blockedParentRunId);
  return 0;
}

function printRunTreeCancellationWarnings(
  cascadeFailures: number,
  blockedParentRunId: string | null
): void {
  if (cascadeFailures > 0) {
    console.log(
      `Warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check \`archon workflow status\`.`
    );
  }
  if (blockedParentRunId) {
    console.log(
      `Warning: parent run ${blockedParentRunId} was blocked on this sub-run and stays paused.`
    );
    console.log(
      `  Resume it so it reads this sub-run's outcome (archon workflow resume ${blockedParentRunId}) or abandon it too.`
    );
  }
}

/**
 * Cancel a running run through the shared `cancelWorkflow` op.
 *
 * Ordering is the contract: prove the live exact-run owner, terminate its process
 * tree, then record `cancelled`. An unreachable owner never falls back to a DB-only
 * transition — the refusal points at `abandon` for an orphan the operator has verified.
 */
export async function workflowCancelCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const { cancelWorkflow } = host.operations;

  const cancel = async (): Promise<{ resolvedId: string; result: CancelWorkflowResult }> => {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    try {
      const result = await cancelWorkflow(resolvedId, { kind: 'operator' });
      if (result.kind === 'cooperative' && !result.cancelled) {
        throw new Error(`Workflow run ${resolvedId} already finished; nothing to cancel.`);
      }
      return { resolvedId, result };
    } catch (error) {
      if (error instanceof CancelRefusedError && error.reason === 'no_owner_answered') {
        throw new Error(`${error.message}\nAbandon it: archon workflow abandon ${resolvedId}`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  if (json) {
    try {
      const { resolvedId, result } = await cancel();
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'cancel',
        status: 'cancelled',
        processStopped: result.kind === 'stopped',
        workflowName: result.run.workflow_name,
        ...(result.kind === 'stopped' && result.cleanupWarnings
          ? { cleanupWarnings: result.cleanupWarnings }
          : {}),
        ...(result.kind === 'stopped' && result.cascadeFailures > 0
          ? { cascadeFailures: result.cascadeFailures }
          : {}),
        ...(result.kind === 'stopped' && result.blockedParentRunId
          ? { blockedParentRunId: result.blockedParentRunId }
          : {}),
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'cancel', error);
      return 1;
    }
  }

  const { resolvedId, result } = await cancel();
  if (result.kind === 'cooperative') {
    console.log(`Cancelled workflow run: ${resolvedId}`);
    console.log(`Workflow: ${result.run.workflow_name}`);
    console.log("It runs inside its parent run's process and stops at its next status check.");
    return 0;
  }
  console.log(`Cancelled detached workflow run: ${resolvedId}`);
  console.log(`Workflow: ${result.run.workflow_name}`);
  console.log('Host process tree stopped before run state was changed.');
  for (const warning of result.cleanupWarnings ?? []) console.log(`Warning: ${warning}`);
  printRunTreeCancellationWarnings(result.cascadeFailures, result.blockedParentRunId);
  return 0;
}

/**
 * The origin a CLI answer records. `--occurrence` refuses the answer unless the run is
 * still paused at that occurrence, read the way run-attention reports it.
 */
async function cliAnswerOrigin(
  host: WorkflowHost,
  runId: string,
  occurrence: string | undefined
): Promise<GateAnswerOrigin> {
  if (occurrence === undefined) return { via: 'cli' };
  const run = await host.deps.store.getWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  return cliOriginForRun(run, occurrence);
}

function cliOriginForRun(run: WorkflowRun, occurrence: string | undefined): GateAnswerOrigin {
  return occurrence === undefined
    ? { via: 'cli' }
    : { via: 'cli', expectedGate: expectedGateForOccurrence(run, occurrence) };
}

/**
 * Continue a run in this process right after this process recorded its answer, the way
 * the CLI's answering commands do outside `--json`. A continuation host may claim the
 * answer first; `workflowRunCommand` reports that and returns.
 */
async function continueAnsweredRun(
  host: WorkflowHost,
  resolvedId: string,
  result: Pick<
    ApprovalOperationResult,
    'workflowName' | 'userMessage' | 'codebaseId' | 'conversationId'
  >,
  workingPath: string,
  action: 'approve' | 'reject' | 'respond' | 'answer',
  failure: { failurePrefix: string; recorded: string }
): Promise<void> {
  // Look up the original platform conversation ID to keep all messages in one thread
  let platformConversationId: string | undefined;
  try {
    const originalConversation = result.conversationId
      ? await host.records.conversations.getConversationById(result.conversationId)
      : null;
    platformConversationId = originalConversation?.platform_conversation_id ?? undefined;
    if (!originalConversation) {
      getLog().info(
        { runId: resolvedId, conversationId: result.conversationId },
        `cli.workflow_${action}_conversation_not_found`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId: resolvedId, conversationId: result.conversationId },
      `cli.workflow_${action}_conversation_lookup_failed`
    );
  }

  try {
    // Use the codebase's source path for workflow YAML discovery so the file is
    // found even when working_path is a worktree or workspace clone that does
    // not contain the user's local (often untracked) workflow YAML.
    const discoveryCwd = result.codebaseId
      ? await resolveDiscoveryCwdForCodebase(host, resolvedId, result.codebaseId, action)
      : undefined;

    await workflowRunCommand(host, workingPath, result.workflowName, result.userMessage ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: (await host.deps.store.getWorkflowRun(resolvedId)) ?? undefined,
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
      discoveryCwd,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.cause instanceof WorkflowResourceBusyError &&
      error.cause.refusal === 'waiting'
    ) {
      console.log(
        `The answer was recorded. Workflow '${result.workflowName}' is waiting for capacity and continues when a slot frees.\n` +
          error.cause.message
      );
      return;
    }
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: result.workflowName },
      `cli.workflow_${action}_resume_failed`
    );
    throw new Error(
      `${failure.failurePrefix} failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The ${failure.recorded} was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`,
      { cause: err }
    );
  }
}

/**
 * Answer a paused attention wait in its declared form: `choose` holds declared option ids,
 * `text` the free text. `occurrence` is required, so an answer prepared for an earlier
 * pause is refused. Like approve, `--json` records the answer for a continuation host;
 * otherwise this process continues the run inline.
 */
export async function workflowAnswerCommand(
  host: WorkflowHost,
  runId: string,
  occurrence: string,
  choose: readonly string[],
  text: string | undefined,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const request = { choose, ...(text !== undefined ? { text } : {}) };
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await host.operations.answerWorkflow(
        resolvedId,
        request,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'answer',
        answer: result.answer,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'answer', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    host.operations.answerWorkflow(
      resolvedId,
      request,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );
  const { workingPath } = result;
  if (!workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Answered workflow: ${result.workflowName}`);
  console.log(`Path: ${workingPath}`);
  console.log('');
  console.log('Resuming workflow...');
  await continueAnsweredRun(host, resolvedId, result, workingPath, 'answer', {
    failurePrefix: 'Answer recorded but',
    recorded: 'answer',
  });
  return 0;
}

/**
 * Approve a paused workflow run by ID.
 *
 * Human mode records the approval on the still-'paused' run (the resolution
 * lives in metadata.approval.resolved, #2075) and then auto-resumes the run
 * inline. `--json` mode records the approval and returns a structured ack
 * WITHOUT resuming (inline resume would stream output and break the JSON); the
 * answered gate is then a due continuation that `archon serve` or `workflow wake`
 * continues.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowApproveCommand(
  host: WorkflowHost,
  runId: string,
  comment?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { approveWorkflow } = host.operations;

  // --detach: hand the approve AND its inline auto-resume to a detached child
  // (same argv minus --detach/--json). Handled BEFORE any state change — the
  // parent only validates read-only, so the approval is recorded exactly once,
  // in the child. Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'approve', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gates approveWorkflow enforces, in the same order — not a copy of
      // one branch of them. A partial copy acks { ok: true } and lets the child die unseen.
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, 'approve', comment);
      // The child always auto-resumes after approving, and the inline path below
      // refuses a run with no recorded working path. Same check here (message
      // copied verbatim) so the refusal is synchronous instead of buried in a log.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
  }

  // JSON mode records the approval and returns a structured ack WITHOUT the
  // inline auto-resume (resuming executes the workflow and streams output to
  // stdout, which would corrupt the JSON contract). The answered gate is a due
  // continuation, so a continuation host (`archon serve`, `workflow wake`) continues it.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await approveWorkflow(
        resolvedId,
        comment,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'approve',
        type: result.type,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'approve', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    approveWorkflow(
      resolvedId,
      comment,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  // CLI auto-resumes after approval, as chat does since #2565. `--json` (handled
  // above) is the one surface that records the decision without continuing.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Approved workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'approve', {
    failurePrefix: 'Approved but',
    recorded: 'approval',
  });
  return 0;
}

/**
 * Reject a paused workflow run by ID.
 * If the workflow has an on_reject prompt, auto-resumes with the rejection feedback;
 * otherwise marks the run as cancelled.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRejectCommand(
  host: WorkflowHost,
  runId: string,
  reason?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { rejectWorkflow } = host.operations;

  // --detach: hand the reject AND its inline on_reject rework to a detached child,
  // exactly as approve does. Without it, reject hosts the executor in the calling
  // shell — a reaped shell (harness task, closed terminal) leaves the run wedged
  // mid-rework. The parent only validates read-only. Composes with --json.
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'reject', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gates rejectWorkflow enforces, in the same order — not a copy of
      // one branch of them. A partial copy acks { ok: true } and lets the child die unseen.
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, 'reject', reason);
      return run;
    });
  }

  // JSON mode records the rejection and returns a structured ack WITHOUT the
  // inline auto-resume (an on_reject rework executes the workflow and streams
  // to stdout, corrupting the JSON contract). When `cancelled` is false the answered
  // gate is a due continuation that a continuation host picks up, except on a container
  // run (including its write-back gate), which needs a manual `resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await rejectWorkflow(
        resolvedId,
        reason,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'reject',
        cancelled: result.cancelled,
        maxAttemptsReached: result.maxAttemptsReached,
        workflowName: result.workflowName,
        resumable: !result.cancelled,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'reject', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    rejectWorkflow(
      resolvedId,
      reason,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    console.log(`Rejected and cancelled${suffix}: ${result.workflowName}`);
    return 0;
  }

  // Not cancelled = a legacy on_reject rework, a #2707 step-1 new-mode
  // resolution, or a container write-back reject (discard the overlay). All
  // three auto-resume; the resume drives the rework / continuation / the
  // overlay discard + completion.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Rejected workflow: ${result.workflowName}`);
  console.log(
    result.writeBack
      ? 'Discarding container changes (live folder left untouched)...'
      : result.newMode
        ? 'Resuming...'
        : 'Resuming with on_reject prompt...'
  );

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'reject', {
    failurePrefix: 'Rejected but',
    recorded: 'rejection',
  });
  return 0;
}

/**
 * Resolve a paused workflow run with any of its gate's declared decisions (#2707 step 2).
 * `approve`/`reject` delegate to the existing commands' exact behavior (the general-purpose
 * function underneath is the same `respondToWorkflow`, which is sugar over
 * `approveWorkflow`/`rejectWorkflow` for those two ids); any other declared decision always
 * resolves immediately and auto-resumes, mirroring `approve`'s shape.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRespondCommand(
  host: WorkflowHost,
  runId: string,
  decision: string,
  text?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { respondToWorkflow } = host.operations;

  if (decision === 'approve')
    return workflowApproveCommand(host, runId, text, json, cwd, detach, occurrence);
  if (decision === 'reject')
    return workflowRejectCommand(host, runId, text, json, cwd, detach, occurrence);

  // --detach: same shape as approve/reject — the parent validates read-only via the
  // SAME gate respondToWorkflow enforces, then hands the whole command to a detached
  // child. See runDetachedControlCommand's doc comment.
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'respond', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, decision, text);
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
  }

  // JSON mode records the decision and returns a structured ack WITHOUT the inline
  // auto-resume, mirroring approve/reject; a continuation host continues the answered gate.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await respondToWorkflow(
        resolvedId,
        decision,
        text,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'respond',
        decision,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'respond', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    respondToWorkflow(
      resolvedId,
      decision,
      text,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Responded '${decision}' to workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'respond', {
    failurePrefix: 'Response recorded but',
    recorded: 'response',
  });
  return 0;
}

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter rules:
 *   - workflow-name required (positional)
 *   - --scope <key>: restrict to one scope (e.g. a conversation UUID); when
 *     omitted, deletes across ALL scopes (use --yes to skip the confirmation)
 *   - --node <id>: restrict to one node within the scope
 *   - --json: machine-readable output
 */
export async function workflowResetSessionsCommand(
  host: WorkflowHost,
  workflowName: string,
  options: { scope?: string; node?: string; yes?: boolean; json?: boolean }
): Promise<void> {
  const { resetWorkflowNodeSessions } = host.operations;

  if (!options.scope && !options.yes) {
    throw new Error(
      `Refusing to delete every persisted session for workflow '${workflowName}' across all scopes without confirmation.\n` +
        'Pass --scope <key> to narrow, or --yes to confirm cross-scope reset.'
    );
  }
  try {
    const { deleted } = await resetWorkflowNodeSessions({
      workflow_name: workflowName,
      scope_key: options.scope,
      node_id: options.node,
    });
    if (options.json) {
      await writeStdout(
        `${JSON.stringify({
          workflow: workflowName,
          deleted,
          scope: options.scope ?? null,
          node: options.node ?? null,
        })}\n`
      );
    } else if (deleted === 0) {
      console.log(`No persisted sessions matched for workflow '${workflowName}'.`);
    } else {
      const scope = options.scope ? ` in scope '${options.scope}'` : ' across all scopes';
      const node = options.node ? ` for node '${options.node}'` : '';
      console.log(
        `Deleted ${deleted} persisted session(s) for workflow '${workflowName}'${node}${scope}.`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName, ...options }, 'cli.workflow_reset_sessions_failed');
    throw new Error(`Failed to reset workflow sessions: ${err.message}`);
  }
}

/**
 * Delete terminal workflow runs older than the given number of days.
 */
export async function workflowCleanupCommand(host: WorkflowHost, days: number): Promise<void> {
  let deleted: number | undefined;
  try {
    const { count } = await host.deps.store.deleteOldWorkflowRuns(days);
    deleted = count;
    const { count: revisions } = await host.deps.store.pruneStateRevisions(days);
    console.log(`Pruned ${revisions} state revision(s) older than ${days} days.`);
    if (count === 0) {
      console.log(`No workflow runs older than ${days} days to clean up.`);
    } else {
      console.log(`Deleted ${count} workflow run(s) older than ${days} days.`);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, days, deleted }, 'cli.workflow_cleanup_failed');
    if (deleted !== undefined)
      throw new Error(
        `Deleted ${deleted} workflow run(s) older than ${days} days, but failed to prune state revisions: ${err.message}`,
        { cause: error }
      );
    throw new Error(`Failed to clean up workflow history: ${err.message}`, { cause: error });
  }
}

export function isValidEventType(value: string): value is WorkflowEventType {
  return (WORKFLOW_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Emit a workflow event directly to the database.
 * Required event writes propagate storage failures; ordinary observability remains best-effort.
 */
export async function workflowEventEmitCommand(
  host: WorkflowHost,
  runId: string,
  eventType: WorkflowEventType,
  data?: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  const resolvedId = await resolveRunIdArg(host, runId, cwd, true);
  const store = host.deps.store;
  if (eventType === 'workflow.checkout_shared') {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data: checkoutSharedEventDataSchema.parse(data),
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  if (isDurableWorkflowEventType(eventType)) {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data,
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  await store.createWorkflowEvent({
    workflow_run_id: resolvedId,
    event_type: eventType,
    data,
  });
  // createWorkflowEvent is non-throwing (fire-and-forget) — the event may not
  // have been persisted if the DB was unavailable. Check server logs if missing.
  console.log(`Event submitted (best-effort): ${eventType} for run ${resolvedId}`);
}
