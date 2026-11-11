import { dueBlocked } from '../../.shared/build.ts';
import { emit, input, refuse, runId as workflowRunId } from 'archon:script';

try {
  const revisits = input('number').trim() === '' && input('revisit_blocked').trim() === 'true';
  const blocked = revisits ? dueBlocked(new Date().toISOString(), workflowRunId()) : [];
  emit({ blocked, blocked_count: blocked.length });
} catch (error) {
  refuse(`build-queue blocked: ${error instanceof Error ? error.message : String(error)}`);
}
