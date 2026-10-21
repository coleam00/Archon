import { dueBlocked } from '../../.shared/build.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';

try {
  const revisits = trimmed(process.env.INPUTS_NUMBER) === '' && trimmed(process.env.INPUTS_RETRIAGE_AS) !== '';
  const blocked = revisits ? dueBlocked(new Date().toISOString()) : [];
  emit({ blocked, blocked_count: blocked.length });
} catch (error) {
  refuse(`build-queue blocked: ${error instanceof Error ? error.message : String(error)}`);
}
