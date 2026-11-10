/**
 * The typed outputs of one run: the output of every node that declared `output_type`,
 * read back from the run's artifacts through the typed-artifact reader.
 *
 * This is the read for a caller that wants the values, of its own run or another one,
 * without knowing where a run keeps them. A run's artifacts do not last, so a run whose
 * artifact directory is gone answers `missing`, never an empty list.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { compareProduction, readNodeArtifacts } from './artifacts-index';
import type { NodeArtifact, NodeArtifactReadError } from './schemas/node-artifact';

type RunOutputIdentity = Pick<
  NodeArtifact,
  'nodeId' | 'outputType' | 'loopGroupPath' | 'producedAt'
>;

/** One typed output: who produced it, when it completed, and its value. */
export type RunOutput = RunOutputIdentity & {
  /**
   * The node's output parsed as JSON, which is what an `output_format` node's certified
   * output is. A node that declares `output_type` alone outputs text, and text that is
   * not JSON is the value as written.
   */
  value: unknown;
};

/**
 * A record that yielded no value. A sidecar the reader rejected has no trustworthy
 * identity; an output whose content could not be read keeps the identity its sidecar gave.
 */
export type UnreadableRunOutput = NodeArtifactReadError & Partial<RunOutputIdentity>;

export type RunOutputs =
  | { artifacts: 'present'; outputs: RunOutput[]; unreadable: UnreadableRunOutput[] }
  /** The run's artifact directory does not exist: cleaned up, or never created. */
  | { artifacts: 'missing' };

export interface RunOutputsFilter {
  /** Exact, case-sensitive `output_type`. */
  type?: string;
  /** Exact node id, as the producing workflow names the node. */
  nodeId?: string;
}

/**
 * Read a run's typed outputs in production order, optionally narrowed to one type or
 * node. Every selected output comes back as a value or as an `unreadable` record. A
 * sidecar the reader could not identify is reported for every selection, since it
 * could have been any type.
 */
export async function readRunOutputs(
  artifactsDir: string,
  runId: string,
  filter: RunOutputsFilter = {}
): Promise<RunOutputs> {
  try {
    await stat(artifactsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { artifacts: 'missing' };
    throw error;
  }
  const read = await readNodeArtifacts(artifactsDir, { scope: 'current-run', runId });
  // The reader keeps an artifact whose content is missing and reports the fault under
  // the sidecar's path. Reading the content below reports the same fault with the
  // output's identity, and only for the outputs this call selected.
  const unreadable: UnreadableRunOutput[] = read.errors.filter(
    error => error.kind !== 'missing_content' && error.kind !== 'unreadable_content'
  );
  const selected = Object.values(read.artifactsByType)
    .flat()
    .filter(
      artifact =>
        (filter.type === undefined || artifact.outputType === filter.type) &&
        (filter.nodeId === undefined || artifact.nodeId === filter.nodeId)
    )
    .sort(compareProduction);

  const outputs: RunOutput[] = [];
  for (const artifact of selected) {
    const identity: RunOutputIdentity = {
      nodeId: artifact.nodeId,
      outputType: artifact.outputType,
      ...(artifact.loopGroupPath !== undefined ? { loopGroupPath: artifact.loopGroupPath } : {}),
      producedAt: artifact.producedAt,
    };
    let content: string;
    try {
      // The reader already refused a content path that leaves the run's directory.
      content = await readFile(join(artifactsDir, artifact.path), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      unreadable.push({
        path: artifact.path,
        kind: code === 'ENOENT' ? 'missing_content' : 'unreadable_content',
        ...(code !== undefined ? { code } : {}),
        ...identity,
      });
      continue;
    }
    outputs.push({ ...identity, value: outputValue(content) });
  }
  return { artifacts: 'present', outputs, unreadable };
}

function outputValue(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}
