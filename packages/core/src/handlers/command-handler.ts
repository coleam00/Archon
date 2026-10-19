/**
 * Command handler for slash commands
 * Handles deterministic operations without AI. Each command group lives under
 * `./commands/`; this module parses the command and routes it.
 */
import { parseSlashCommand } from '../utils/command-args';
import type { RunActor } from '../operations/run-authorization';
import type { WorkflowOperations } from '../operations/workflow-operations';
import type { WorkflowCommandSurface } from '@archon/workflows/deps';
import type { Conversation, CommandResult } from '../types';
import { createSqlWorkflowOperations } from '../workflows/sql-host';
import { helpCommand, listRegisteredCommands } from './commands/help';
import { handleStatusCommand } from './commands/status';
import { handleResetCommand } from './commands/reset';
import { handleWorktreeCommand } from './commands/worktree';
import { handleWorkflowCommand } from './commands/workflow';
import { handleInitCommand } from './commands/init';

export { startWorkflow } from './commands/workflow';

export function parseCommand(text: string): { command: string; args: string[] } {
  return parseSlashCommand(text);
}

export async function handleCommand(
  conversation: Conversation,
  message: string,
  actor: RunActor,
  surface: WorkflowCommandSurface = {},
  operations: WorkflowOperations = createSqlWorkflowOperations()
): Promise<CommandResult> {
  const { command, args } = parseCommand(message);

  switch (command) {
    case 'help':
      return helpCommand(surface);
    case 'status':
      return handleStatusCommand(conversation, surface);
    case 'commands':
      return listRegisteredCommands(conversation);
    case 'reset':
      return handleResetCommand(conversation, actor, operations);
    case 'worktree':
      return handleWorktreeCommand(conversation, args);
    case 'workflow':
      return handleWorkflowCommand(operations, conversation, args, surface, actor);
    case 'init':
      return handleInitCommand(conversation);
    default:
      return {
        success: false,
        message: `Unknown command: /${command}\n\nType /help to see available commands.`,
      };
  }
}
