import { ensureUtc } from '@/lib/format';
import type { WorkflowEventResponse } from '@/lib/api';

/**
 * Format the DB workflow events for a single DAG node into the flat list of log
 * lines rendered by `StepLogs`.
 *
 * Returns one array element per visual line (not per event): a completed
 * bash/script node carries its captured stdout in `node_output`, which we
 * surface as indented lines beneath the "Node completed" summary. Splitting on
 * newlines here (rather than embedding `\n`) keeps `StepLogs`' virtualizer
 * geometry accurate — it estimates a fixed ~24px per row.
 *
 * The graph node body shows the node's command/definition (e.g.
 * `echo captured: $g.output`), not its runtime output, so the Logs tab is the
 * only place a bash/script node's output — or a captured approval response — is
 * visible to the user.
 */
export function formatStepLogLines(
  events: readonly WorkflowEventResponse[],
  selectedDagNode: string | null
): string[] {
  const stepEvents =
    selectedDagNode !== null ? events.filter(e => e.step_name === selectedDagNode) : [];
  if (stepEvents.length === 0) return [];

  return stepEvents.flatMap((e): string | string[] => {
    const ts = new Date(ensureUtc(e.created_at)).toLocaleTimeString();
    switch (e.event_type) {
      case 'loop_iteration_started':
        return `[${ts}] Iteration ${String(e.data.iteration)}/${String((e.data.maxIterations as number | undefined) ?? '?')} started`;
      case 'loop_iteration_completed': {
        const dur = e.data.duration_ms as number | undefined;
        const durStr = dur !== undefined ? ` (${String(Math.round(dur / 100) / 10)}s)` : '';
        return `[${ts}] Iteration ${String(e.data.iteration)} completed${durStr}`;
      }
      case 'loop_iteration_failed':
        return `[${ts}] Iteration ${String(e.data.iteration)} failed: ${(e.data.error as string | undefined) ?? 'Unknown error'}`;
      case 'node_started':
        return `[${ts}] Node started: ${e.step_name ?? 'node'}`;
      case 'node_completed': {
        const summary = `[${ts}] Node completed: ${e.step_name ?? 'node'}`;
        const output = typeof e.data.node_output === 'string' ? e.data.node_output.trimEnd() : '';
        return output ? [summary, ...output.split('\n').map(line => `  ${line}`)] : summary;
      }
      case 'node_failed':
        return `[${ts}] Node failed: ${e.step_name ?? 'node'}: ${(e.data.error as string | undefined) ?? 'Unknown error'}`;
      case 'node_skipped':
        return `[${ts}] Node skipped: ${e.step_name ?? 'node'}`;
      default:
        return `[${ts}] ${e.event_type}${e.step_name ? `: ${e.step_name}` : ''}`;
    }
  });
}
