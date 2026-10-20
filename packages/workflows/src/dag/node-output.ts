import { join as joinPath } from 'path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { buildTruncationMarker } from '../utils/output-truncation';
import type { WorkflowRun } from '../schemas';
import { validateArtifactPointers } from '../artifact-pointer';
import { writeSpillFile } from './shell-quote';

/** UTF-16 code-unit threshold for shell reference spills (JavaScript string.length). */
export const NODE_OUTPUT_FILE_THRESHOLD = 32_768;

/** Maximum UTF-8 bytes retained for a successful exec node's stdout in workflow events. */
export const PERSISTED_NODE_OUTPUT_MAX_BYTES = 32 * 1024;

export function utf8SequenceLength(leadByte: number): number {
  if (leadByte < 0x80) return 1;
  if (leadByte < 0xe0) return 2;
  if (leadByte < 0xf0) return 3;
  return 4;
}

/**
 * Cap `output` to a bounded preview for persistence, and — when it exceeds the cap —
 * ALSO spill the full, untruncated bytes under the run's artifacts directory so a
 * resumed run can rehydrate the complete value instead of the preview (#2726).
 *
 * `spillKey` should be the row's own `step_name` (`stepNamePrefix + node.id`), matching
 * exactly what `getDagResumeSnapshot` keys `completedNodeOutputs` by. A loop_group body
 * node's `step_name` is the SAME across every iteration (only `data.iteration` differs
 * per row), and `completedNodeOutputs` is already last-write-wins per `step_name` — so
 * the spill file holds the latest execution for that key. Recovery of an earlier
 * iteration must reject a spill overwritten by a later execution.
 *
 * A spill write failure never fails the node — it degrades to preview-only persistence,
 * matching `shellQuoteOrFile`'s existing fallback behavior for the same class of error.
 *
 * Because the spill filename is reused, `foldDagResumeSnapshot` (dag-resume-snapshot.ts)
 * checks its byte length against the row's `originalBytes`. A later execution can
 * overwrite the file before its event commits; a length mismatch exposes that stale
 * pairing. The check cannot distinguish different contents of the same length.
 */
export function formatPersistedNodeOutput(
  output: string,
  artifactsDir: string,
  spillKey: string
): {
  nodeOutput: string;
  truncated: boolean;
  originalBytes?: number;
  spillPath?: string;
} {
  const outputBytes = Buffer.from(output, 'utf8');
  if (outputBytes.byteLength <= PERSISTED_NODE_OUTPUT_MAX_BYTES) {
    return { nodeOutput: output, truncated: false };
  }

  const marker = buildTruncationMarker(outputBytes.byteLength);
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let headEnd = PERSISTED_NODE_OUTPUT_MAX_BYTES - markerBytes;

  // The byte cap can land inside a multi-byte code point. Inspect the final
  // sequence in the prefix and drop it when it is incomplete before decoding.
  let sequenceStart = headEnd - 1;
  while (sequenceStart >= 0 && (outputBytes[sequenceStart] & 0xc0) === 0x80) {
    sequenceStart--;
  }
  if (sequenceStart >= 0) {
    const leadByte = outputBytes[sequenceStart];
    const expectedLength = utf8SequenceLength(leadByte);
    if (headEnd - sequenceStart < expectedLength) headEnd = sequenceStart;
  }

  const spillDir = joinPath(
    artifactsDir,
    RUN_ARTIFACTS_ENGINE_SUBDIR,
    'node-output-spills',
    'persisted'
  );
  const spillPath = writeSpillFile(spillDir, `${spillKey}.nodeoutput`, output);

  return {
    nodeOutput: outputBytes.subarray(0, headEnd).toString('utf8') + marker,
    truncated: true,
    originalBytes: outputBytes.byteLength,
    ...(spillPath ? { spillPath } : {}),
  };
}

/** Carry the bounded persistence preview separately from the complete runtime text. */
export function persistedExecutionOutput(
  persistedOutput: ReturnType<typeof formatPersistedNodeOutput>,
  text = persistedOutput.nodeOutput
): import('../schemas/node-execution').ExecutionOutput {
  return {
    text,
    persisted: {
      text: persistedOutput.nodeOutput,
      truncated: persistedOutput.truncated,
      ...(persistedOutput.originalBytes !== undefined
        ? { originalBytes: persistedOutput.originalBytes }
        : {}),
      ...(persistedOutput.spillPath !== undefined ? { spillPath: persistedOutput.spillPath } : {}),
    },
  };
}

/**
 * Prove every reserved artifact pointer in a value the engine is about to persist (#2453).
 *
 * Called ONLY where a value is PRODUCED — an AI node, a loop iteration, a certified
 * `bash:`/`script:` stdout — and validated against that producer's own run. A `workflow:`
 * parent and a fan-out aggregate relay a child's value as-is: the child already proved it
 * against the only run a pointer may name. A value carrying no pointer costs one walk and
 * no I/O, so the check is unconditional rather than gated on a declared `output_format`:
 * the `archon_artifact` discriminator is reserved everywhere, not only inside a contract.
 *
 * Returns the rejection reason, phrased to complete `Node '<id>': <reason>.`, or `null`.
 */
export async function rejectedArtifactPointer(
  run: WorkflowRun,
  value: unknown
): Promise<string | null> {
  return validateArtifactPointers(value, run);
}
