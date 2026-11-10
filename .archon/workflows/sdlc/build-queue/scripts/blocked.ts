import { dueBlocked } from '../../.shared/build.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

try {
  const revisits = trimmed(process.env.INPUTS_NUMBER) === '' && trimmed(process.env.INPUTS_REVISIT_BLOCKED) === 'true';
  const blocked = revisits ? dueBlocked(new Date().toISOString()) : [];
  emit<NodeOutput<'archon-build-queue', 'blocked'>>({ blocked, blocked_count: blocked.length });
} catch (error) {
  refuse(`build-queue blocked: ${error instanceof Error ? error.message : String(error)}`);
}
