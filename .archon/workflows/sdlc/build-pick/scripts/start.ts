/**
 * Resolve the repository the run works on, and whether its message names the work.
 *
 * A run with a message (`$ARGUMENTS`) was started by a person saying what to build; the
 * interpret agent reads the message. Every other run starts what waits, as a scheduled
 * run does.
 */

import { emit, refuse } from 'archon:script';
import { workflowRepo } from '../../.shared/remote.ts';

try {
  emit({
    repo: workflowRepo(),
    message: (process.env.ARGUMENTS ?? '').trim() !== '',
  });
} catch (error) {
  refuse(`build-pick start: ${error instanceof Error ? error.message : String(error)}`);
}
