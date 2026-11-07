import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  runThroughput,
  throughputAcrossRuns,
  type RunThroughput,
  type ThroughputSummary,
} from '@archon/workflows/throughput';
import { NODE_SUMMARY_EVENT_TYPES, withRunDetail } from './workflow-node-summaries';

export function formatThroughput(summary: ThroughputSummary): string {
  const rate = summary.effectiveTokensPerSecond;
  const parts = [rate === null ? 'unavailable' : `${rate.toFixed(2)} tok/s`];
  if (summary.nodesWithoutTokenData)
    parts.push(`${summary.nodesWithoutTokenData} nodes without token data`);
  if (summary.nodesWithoutDuration)
    parts.push(`${summary.nodesWithoutDuration} nodes without usable duration`);
  return parts.join('; ');
}

export function printRunThroughput(report: RunThroughput | undefined): void {
  if (!report) return;
  console.log('  Effective output throughput (recorded agent executions; not decode speed):');
  console.log(`    Run: ${formatThroughput(report.summary)}`);
  console.log('    Counts refer to recorded execution attempts.');
  for (const node of report.nodes) {
    const rate = node.effectiveTokensPerSecond;
    console.log(
      `    ${node.path} · loop ${JSON.stringify(node.invocation?.loopPath ?? [])} · invocation ${node.invocation?.id ?? 'not recorded'} · attempt ${node.attempt?.id ?? 'not recorded'} · ${node.provider ?? 'not recorded'}/${node.requestedModel ?? 'not recorded'}: ${rate === null ? `unavailable (${node.exclusion === 'tokens' ? 'without token data' : 'without usable duration'})` : `${rate.toFixed(2)} tok/s`}`
    );
  }
}

export function printModelThroughput(
  report: ReturnType<typeof throughputAcrossRuns> | undefined
): void {
  if (!report) return;
  console.log(
    `Effective output throughput across listed runs (${report.runCount} runs; recorded agent executions; not decode speed):`
  );
  console.log('  Counts refer to recorded execution attempts.');
  for (const model of report.models) {
    console.log(
      `  ${model.provider ?? 'not recorded'}/${model.requestedModel ?? 'not recorded'}: ${formatThroughput(model)}`
    );
  }
}

export async function listedRunThroughput<
  Run extends Pick<WorkflowRun, 'id' | 'status' | 'metadata' | 'completed_at'>,
>(
  host: WorkflowHost,
  runs: Run[],
  options: { throughput?: boolean; json?: boolean; verbose?: boolean }
) {
  if (!options.throughput) return undefined;
  const verbose = options.json === true && options.verbose === true;
  const events = new Map<string, WorkflowEventRow[]>();
  for (let start = 0; start < runs.length; start += 20) {
    if (start > 0) await new Promise<void>(resolve => setImmediate(resolve));
    const ids = runs.slice(start, start + 20).map(run => run.id);
    const fetched = await host.deps.store.listEventsForRuns(
      ids,
      verbose ? NODE_SUMMARY_EVENT_TYPES : ['node_completed', 'node_failed']
    );
    for (const id of ids) events.set(id, fetched.get(id) ?? []);
  }
  const measured = runs.map(run => {
    try {
      return { ...run, throughput: runThroughput(run.id, events.get(run.id) ?? []) };
    } catch (error) {
      throw new Error(
        `Cannot compute throughput for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  });
  const detailed = verbose ? await withRunDetail(host, measured, events) : measured;
  return { runs: detailed, throughput: throughputAcrossRuns(measured.map(run => run.throughput)) };
}

export function printListedRunThroughput(
  runId: string,
  runs: readonly { id: string; throughput: RunThroughput }[] | undefined
): void {
  const measured = runs?.find(run => run.id === runId);
  if (measured)
    console.log(
      `  ${runId.slice(0, 8)} effective throughput: ${formatThroughput(measured.throughput.summary)}`
    );
}
