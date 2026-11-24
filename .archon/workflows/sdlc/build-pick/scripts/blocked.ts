import { dueBlocked } from '../../.shared/build.ts';
import { emit, input, refuse, runId as workflowRunId } from 'archon:script';

try {
  // A person's message is one request; only a pass that starts what waits also revisits.
  const revisits = (process.env.ARGUMENTS ?? '').trim() === '' && input('revisit_blocked').trim() === 'true';
  const blocked = revisits ? dueBlocked(new Date().toISOString(), workflowRunId()) : [];
  emit({ blocked, blocked_count: blocked.length });
} catch (error) {
  refuse(`build-pick blocked: ${error instanceof Error ? error.message : String(error)}`);
}
