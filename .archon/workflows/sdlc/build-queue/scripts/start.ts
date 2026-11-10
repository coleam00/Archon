/**
 * Resolve the repository the run works on, and whether its message names the work.
 *
 * A run whose `number` is empty and whose message (`$ARGUMENTS`) is not was started by
 * a person saying what to build; the interpret agent reads the message. Every other
 * run picks up as a scheduled run does.
 */

import { emit, refuse, trimmed } from '../../.shared/io.ts';
import { workflowRepo } from '../../.shared/remote.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

try {
  emit<NodeOutput<'archon-build-queue', 'start'>>({
    repo: workflowRepo(),
    message: trimmed(process.env.INPUTS_NUMBER) === '' && trimmed(process.env.ARGUMENTS) !== '',
  });
} catch (error) {
  refuse(`build-queue start: ${error instanceof Error ? error.message : String(error)}`);
}
