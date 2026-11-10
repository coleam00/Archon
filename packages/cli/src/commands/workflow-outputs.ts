import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { readRunOutputs, type RunOutputs } from '@archon/workflows/run-outputs';
import { writeJsonLine, writeStdout } from '../utils/stdout';
import { fail, resolveRunArtifacts } from './workflow-artifacts';
import { getLog } from './workflow-shared';

interface OutputsOptions {
  json?: boolean;
  cwd?: string;
  type?: string;
  node?: string;
}

/**
 * One requested run's answer. `unknown` is a run this call could not read at all: no
 * such run, no resolvable output location, or a read that failed, as `error` says.
 */
type RunOutputsEntry =
  | ({ runId: string; artifactsDir: string } & RunOutputs)
  | { runId: string; artifacts: 'unknown'; error: string };

/**
 * `archon workflow outputs <run-id>...`: the typed outputs of each named run, in
 * production order. Read-only and serverless; a run id resolves exactly as
 * `workflow artifacts` resolves it. `args` are the positionals after `outputs`.
 *
 * Every run is answered in the one document, so a caller reading many runs learns
 * which of them it cannot read without losing the rest. Exits 1 when any is `unknown`.
 */
export async function workflowOutputsCommand(
  host: WorkflowHost,
  args: string[],
  opts: OutputsOptions
): Promise<number> {
  if (args.length === 0) {
    return fail(
      opts.json,
      'Usage: archon workflow outputs <run-id>... [--type <output_type>] [--node <id>] [--json]'
    );
  }
  const runs: RunOutputsEntry[] = [];
  for (const runId of args) runs.push(await readEntry(host, runId, opts));
  if (opts.json) await writeJsonLine({ runs });
  else await writeStdout(`${runs.flatMap(describeEntry).join('\n')}\n`);
  return runs.some(entry => entry.artifacts === 'unknown') ? 1 : 0;
}

async function readEntry(
  host: WorkflowHost,
  runId: string,
  opts: OutputsOptions
): Promise<RunOutputsEntry> {
  const resolved = await resolveRunArtifacts(host, runId, opts.cwd);
  if ('error' in resolved) return { ...resolved, artifacts: 'unknown' };
  const { run, artifactsDir } = resolved;
  try {
    const read = await readRunOutputs(artifactsDir, run.id, { type: opts.type, nodeId: opts.node });
    return { runId: run.id, artifactsDir, ...read };
  } catch (error) {
    getLog().error({ err: error as Error, runId: run.id }, 'cli.workflow_outputs_failed');
    return { runId: run.id, artifacts: 'unknown', error: (error as Error).message };
  }
}

function describeEntry(entry: RunOutputsEntry): string[] {
  if (entry.artifacts === 'unknown') return [`Run ${entry.runId}: ${entry.error}`];
  if (entry.artifacts === 'missing') {
    return [`Run ${entry.runId}: its artifacts are gone, so its typed outputs cannot be read.`];
  }
  const lines = [`Typed outputs of run ${entry.runId} (values with --json):`];
  if (entry.outputs.length === 0) lines.push('  No typed outputs.');
  for (const output of entry.outputs) {
    const loop = (output.loopGroupPath ?? [])
      .map(frame => ` ${frame.groupId}#${String(frame.iteration)}`)
      .join('');
    lines.push(`  - ${output.producedAt}  ${output.outputType}  ${output.nodeId}${loop}`);
  }
  for (const record of entry.unreadable) {
    lines.push(
      `  Unreadable: ${record.path} (${record.kind}${record.code ? ` ${record.code}` : ''})`
    );
  }
  return lines;
}
