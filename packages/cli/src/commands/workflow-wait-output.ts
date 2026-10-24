import type { RunWaitResult } from '@archon/core/services/run-attention-watch';
import { writeJsonLine } from '../utils/stdout';
import { formatWaitOutcome } from './workflow-inspect';

export async function writeWaitOutcome(
  runId: string,
  resolvedId: string,
  result: RunWaitResult,
  json: boolean | undefined
): Promise<void> {
  if (result.kind === 'not_found') {
    if (json) {
      await writeJsonLine({ ok: false, runId, action: 'wait', error: 'not_found' });
    } else {
      console.log(formatWaitOutcome(resolvedId, result));
    }
    return;
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
}
