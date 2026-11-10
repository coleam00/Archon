/**
 * Runs' typed outputs of one type, through the host's `archon workflow outputs`.
 *
 * The engine certifies a node's typed output and answers for it: each output with the
 * node that produced it, its loop position, the time it completed and its value, in
 * the order the run produced them. The same read serves this run and any other run of
 * the project, so nothing here knows where a run keeps its artifacts. A typed output's
 * value is certified, so a reader trusts its shape. What can still go wrong is the
 * read: those faults come back for the caller to name, never as silence.
 */

import { archonCommand, record } from './forge.ts';

export type LoopFrame = { readonly groupId: string; readonly iteration: number };

export interface RunOutput<T> {
  readonly nodeId: string;
  readonly loopGroupPath?: readonly LoopFrame[];
  /** When the node completed, ISO-8601. */
  readonly producedAt: string;
  readonly value: T;
}

export type RunOutputs<T> =
  | {
      readonly state: 'read';
      /** The run's artifact directory, for the files it wrote beside its typed outputs. */
      readonly artifactsDir: string;
      readonly outputs: readonly RunOutput<T>[];
      /** Outputs of this type, or records of no known type, that the engine could not read. */
      readonly problems: readonly string[];
    }
  /** The run's artifacts have been cleaned up: it has no outputs left to read. */
  | { readonly state: 'gone'; readonly problem: string }
  /** The run could not be read at all, so nothing is known about its outputs. */
  | { readonly state: 'unknown'; readonly problem: string };

/** One call names at most this many runs, to bound its argv and its answer. */
const BATCH = 100;

function readBatch<T>(runIds: readonly string[], type: string): RunOutputs<T>[] {
  const unknown = (problem: string): RunOutputs<T>[] => runIds.map(() => ({ state: 'unknown', problem }));
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([...archonCommand(), 'workflow', 'outputs', ...runIds, '--type', type, '--json'], {
      // Bun spawns with the environment as the process started unless given the live one.
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error));
  }
  let document: Record<string, unknown> | undefined;
  try {
    document = record(JSON.parse(result.stdout?.toString() ?? ''));
  } catch {
    document = undefined;
  }
  // One entry per named run, in the order named, whatever the exit code.
  const runs = document?.runs;
  if (!Array.isArray(runs) || runs.length !== runIds.length) {
    const error = document?.error;
    return unknown(
      `archon workflow outputs failed (exit ${String(result.exitCode)})${typeof error === 'string' ? `: ${error}` : ''}`
    );
  }
  return runs.map((entry, index): RunOutputs<T> => {
    const run = record(entry);
    const id = runIds[index] ?? '';
    if (run?.artifacts === 'missing') return { state: 'gone', problem: `the artifacts of run ${id} are gone` };
    if (run?.artifacts !== 'present') {
      return { state: 'unknown', problem: `run ${id} could not be read (${String(run?.error)})` };
    }
    return {
      state: 'read',
      artifactsDir: run.artifactsDir as string,
      outputs: run.outputs as RunOutput<T>[],
      problems: (run.unreadable as { path: string; kind: string; code?: string }[]).map(
        fault =>
          `${fault.path} (${fault.kind}${fault.code === undefined ? '' : `, ${fault.code}`}): the engine could not read this record`
      ),
    };
  });
}

/** Each named run's outputs of the type, by run id. */
export function outputsOfRuns<T>(runIds: readonly string[], type: string): Map<string, RunOutputs<T>> {
  const read = new Map<string, RunOutputs<T>>();
  for (let start = 0; start < runIds.length; start += BATCH) {
    const batch = runIds.slice(start, start + BATCH);
    readBatch<T>(batch, type).forEach((outputs, index) => read.set(batch[index] ?? '', outputs));
  }
  return read;
}

/** One run's outputs of the type; a node reads its own run by `WORKFLOW_ID`. */
export function outputsOf<T>(runId: string | undefined, type: string): RunOutputs<T> {
  if (runId === undefined || runId === '') {
    return { state: 'unknown', problem: 'no run id reached this node' };
  }
  return readBatch<T>([runId], type)[0] as RunOutputs<T>;
}
