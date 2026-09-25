/**
 * Cancels a run through the shared `cancelWorkflow` op from a process that does not own
 * it, as the server's API route, chat `/workflow cancel`, the Slack button, and
 * `manage_run` do. Prints one JSON line with the outcome.
 */
import { cancelWorkflow, CancelRefusedError } from '@archon/core/operations/workflow-operations';

const [runId] = process.argv.slice(2);
if (!runId) throw new Error('Usage: cancel-run.ts <run-id>');

try {
  const result = await cancelWorkflow(runId);
  console.log(
    JSON.stringify({
      ok: true,
      kind: result.kind,
      pid: result.kind === 'stopped' ? result.pid : null,
    })
  );
} catch (error) {
  if (!(error instanceof CancelRefusedError)) throw error;
  console.log(JSON.stringify({ ok: false, reason: error.reason, message: error.message }));
}
