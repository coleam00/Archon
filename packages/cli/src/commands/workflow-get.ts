import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { getTerminalRecord, terminalReason } from '@archon/workflows/terminal-record';
import { runThroughput, type RunThroughput } from '@archon/workflows/throughput';
import { buildNodeSummaries, listRunEvents } from './workflow-node-summaries';
import { writeJsonLine } from '../utils/stdout';
import { requestedBy, type RequestedBy } from '../utils/requested-by';
import { getLog, resolveRunIdArg, resolveRunTranscriptPath } from './workflow-shared';
import {
  buildLeaveBehind,
  type LeaveBehind,
  printRunDetail,
  readParseWarningEvents,
} from './workflow-inspect';

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
  rawEvents?: boolean,
  throughput?: boolean
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

  const history = await readGetHistory(host, run, json, rawEvents, throughput);
  if (!history) return 1;
  const { events, terminalRecord, throughputReport } = history;

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

  const origin = await requestedBy(host, run.metadata);
  if (json) {
    return writeWorkflowGetJson(
      { ...run, requested_by: origin },
      transcriptPath,
      terminalRecord,
      leaveBehind,
      events,
      verbose,
      rawEvents,
      throughputReport
    );
  }

  const detail = { transcriptPath, terminalRecord, leaveBehind, events, verbose };
  printRunDetail(run, { ...detail, requestedBy: origin, throughput: throughputReport });
  return 0;
}

async function writeWorkflowGetJson(
  run: WorkflowRun & { requested_by: RequestedBy },
  transcriptPath: string | null,
  terminalRecord: ReturnType<typeof getTerminalRecord>,
  leaveBehind: LeaveBehind | undefined,
  events: WorkflowEventRow[],
  verbose?: boolean,
  rawEvents?: boolean,
  throughput?: RunThroughput
): Promise<number> {
  // Unlike attention streams, this individual read may include the recorded error.
  const reason = terminalReason(terminalRecord);
  const why = reason.length > 0 ? { reason } : {};
  if (!verbose) {
    await writeJsonLine({
      ...run,
      ...(throughput ? { throughput } : {}),
      transcript_path: transcriptPath,
      terminal_record: terminalRecord,
      ...why,
      ...(leaveBehind ? { leave_behind: leaveBehind } : {}),
    });
    return 0;
  }

  const parseWarnings = readParseWarningEvents(events);
  const output = rawEvents
    ? {
        ...run,
        ...(throughput ? { throughput } : {}),
        transcript_path: transcriptPath,
        terminal_record: terminalRecord,
        ...why,
        events,
      }
    : {
        ...run,
        ...(throughput ? { throughput } : {}),
        transcript_path: transcriptPath,
        terminal_record: terminalRecord,
        ...why,
        nodes: buildNodeSummaries(events),
        // Keys the engine dropped from this run's YAML (#2213). Surfaced as a
        // named field rather than leaving the caller to scan raw events.
        ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
      };
  await writeJsonLine(output);
  return 0;
}

async function readGetHistory(
  host: WorkflowHost,
  run: WorkflowRun,
  json: boolean | undefined,
  rawEvents: boolean | undefined,
  throughput: boolean | undefined
) {
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
    return undefined;
  }

  let throughputReport: RunThroughput | undefined;
  if (throughput) {
    try {
      throughputReport = runThroughput(run.id, events);
    } catch (error) {
      const message = `Cannot compute throughput for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`;
      if (json) await writeJsonLine({ ok: false, runId: run.id, error: message });
      else console.log(message);
      return undefined;
    }
  }

  return { events, terminalRecord, throughputReport };
}
