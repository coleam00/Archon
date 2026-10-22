import { getTerminalRecord } from '@archon/workflows/terminal-record';
import { loadConfig } from '@archon/core/config/config-loader';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { DashboardWorkflowRun } from '@archon/workflows/schemas/workflow-run-listing';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { resolveDryRunEnvironment } from './workflow-dry-run';
import { createCliWorkflowHost } from '../utils/workflow-host';
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
  inheritedWorkflowCodebase,
  resolveRunIdArg,
  resolveRunTranscriptPath,
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
      config,
      resolveExecConfig: async () =>
        resolveDryRunEnvironment(await createCliWorkflowHost(), invokingCwd, config),
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

async function verboseStatusRuns(
  host: WorkflowHost,
  runs: DashboardWorkflowRun[],
  rawEvents = false
) {
  const fetchedPerRun = await Promise.all(
    runs.map(run => fetchVerboseEvents(host, run.id, rawEvents))
  );
  if (fetchedPerRun.some(result => result.failed)) {
    throw new Error('Failed to fetch workflow events for verbose status.');
  }
  return runs.map((run, i) => {
    const runEvents = fetchedPerRun[i]?.events ?? [];
    return rawEvents
      ? { ...run, attention: runAttention(run), events: runEvents }
      : { ...run, attention: runAttention(run), nodes: buildNodeSummaries(runEvents) };
  });
}

/** Show active workflow runs for the current project, or every project with `--all`. */
export async function workflowStatusCommand(
  host: WorkflowHost,
  cwd: string,
  opts: { json?: boolean; verbose?: boolean; rawEvents?: boolean; all?: boolean } = {}
): Promise<void> {
  const { getWorkflowStatus } = host.operations;

  let codebase = null;
  try {
    codebase = await inheritedWorkflowCodebase(host, opts.all);
    if (codebase === undefined && !opts.all) {
      codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_status_codebase_lookup_failed');
    throw new Error(`Failed to resolve workflow status project: ${err.message}`, { cause: err });
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

    const runsOutput = await verboseStatusRuns(host, runs, opts.rawEvents);
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
 * status. Outside chat, `--all` lists across all projects;
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
  if (opts.open && opts.status) {
    const msg = '--open and --status are mutually exclusive: the inbox is failed runs only.';
    if (opts.json) {
      await writeJsonLine({ ok: false, error: msg });
      return 1;
    }
    throw new Error(msg);
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

  let codebase = null;
  try {
    codebase = await inheritedWorkflowCodebase(host, opts.all);
    if (codebase === undefined && !opts.all) {
      codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
    const message = `Failed to resolve workflow runs project: ${err.message}`;
    if (opts.json) {
      await writeJsonLine({ ok: false, error: message });
      return 1;
    }
    throw new Error(message, { cause: err });
  }
  // The open-work inbox contains terminal failed runs with no adopter or successor.
  if (opts.open) {
    const runs = await host.deps.store.findOpenWorkRuns({
      codebaseId: codebase?.id,
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

  // listDashboardRuns ignores undefined filters (truthy-guarded WHERE clauses),
  // so pass codebaseId/status straight through — no conditional spread needed.
  const codebaseId = codebase?.id;

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
  // (unregistered cwd). The human path prints a note below;
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
