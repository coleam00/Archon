import type { RunActor } from '../../operations/run-authorization';
import type { WorkflowOperations } from '../../operations/workflow-operations';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type { Conversation } from '../../types';

/** One `/workflow <subcommand>` invocation: its arguments and who sent it from where. */
export interface WorkflowCommand {
  operations: WorkflowOperations;
  conversation: Conversation;
  /** The words after `/workflow`; `args[0]` is the subcommand. */
  args: string[];
  surface: WorkflowCommandSurface;
  actor: RunActor;
}

/** `command` spelled the way the invoking surface accepts it. */
export function spell({ surface }: WorkflowCommand, command: string): string {
  return spellWorkflowCommand(surface, command);
}
