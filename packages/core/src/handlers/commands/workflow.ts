import { providerRegistry } from '@archon/providers';
import { getArchonWorkspacesPath } from '@archon/paths';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName, suggestWorkflowNames } from '@archon/workflows/router';
import {
  findWorkflowLoadError,
  type WorkflowWithSource,
  type WorkflowLoadError,
} from '@archon/workflows/schemas/workflow';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type { RunActor } from '../../operations/run-authorization';
import type { WorkflowOperations } from '../../operations/workflow-operations';
import { loadConfig } from '../../config/config-loader';
import * as codebaseDb from '../../db/codebases';
import type { CommandResult, Conversation } from '../../types';
import { getLog } from './log';
import { spell, type WorkflowCommand } from './workflow-command';
import {
  abandonWorkflowRun,
  cancelWorkflowRun,
  getWorkflowRun,
  listActiveWorkflowRuns,
  resetWorkflowSessions,
  resumeWorkflowRun,
} from './workflow-runs';
import { approveWorkflowRun, rejectWorkflowRun, respondToWorkflowRun } from './workflow-gates';

export async function handleWorkflowCommand(
  operations: WorkflowOperations,
  conversation: Conversation,
  args: string[],
  surface: WorkflowCommandSurface,
  actor: RunActor
): Promise<CommandResult> {
  const input: WorkflowCommand = { operations, conversation, args, surface, actor };
  switch (args[0]) {
    case 'list':
    case 'ls':
      return listWorkflows(conversation);
    case 'reload':
      return reloadWorkflows(conversation);
    case 'cancel':
      return cancelWorkflowRun(input);
    case 'get':
      return getWorkflowRun(input);
    case 'status':
      return listActiveWorkflowRuns(input);
    case 'resume':
      return resumeWorkflowRun(input);
    case 'abandon':
      return abandonWorkflowRun(input);
    case 'reset-sessions':
      return resetWorkflowSessions(input);
    case 'approve':
      return approveWorkflowRun(input);
    case 'reject':
      return rejectWorkflowRun(input);
    case 'respond':
      return respondToWorkflowRun(input);
    case 'run':
      return runWorkflow(input);
    default:
      return workflowUsage(input);
  }
}

async function listWorkflows(conversation: Conversation): Promise<CommandResult> {
  const workflowCwd = await resolveWorkflowCwd(conversation);
  let workflowEntries: readonly WorkflowWithSource[];
  let errors: readonly WorkflowLoadError[];
  try {
    const result = await discoverWorkflowsWithConfig(workflowCwd, loadConfig, providerRegistry);
    workflowEntries = result.workflows;
    errors = result.errors;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_list_failed');
    return {
      success: false,
      message: `Failed to load workflows: ${err.message}`,
    };
  }

  if (workflowEntries.length === 0 && errors.length === 0) {
    return {
      success: true,
      message: 'No workflows found.\n\nCreate workflows in `.archon/workflows/` as YAML files.',
    };
  }

  let msg = '';

  if (workflowEntries.length > 0) {
    msg += 'Available Workflows:\n\n';
    for (const { workflow: w, parseWarnings } of workflowEntries) {
      const modeInfo = `DAG: ${String(w.nodes.length)} nodes`;
      msg += `**\`${w.name}\`**\n  ${w.description}\n  ${modeInfo}\n`;
      // Keys the engine silently drops (#2213). Rendered inline with the
      // workflow rather than in a trailer so the author sees which of their
      // workflows is affected without cross-referencing.
      for (const warning of parseWarnings ?? []) {
        msg += `  ⚠️ ${warning}\n`;
      }
      msg += '\n';
    }
  }

  if (errors.length > 0) {
    const displayErrors = errors.slice(0, 10);
    msg += `\n---\n\n**${String(errors.length)} workflow(s) failed to load:**\n\n`;
    for (const e of displayErrors) {
      msg += `- \`${e.filename}\`: ${e.error}\n`;
    }
    if (errors.length > 10) {
      msg += `\n...and ${String(errors.length - 10)} more\n`;
    }
  }

  return { success: true, message: msg };
}

async function reloadWorkflows(conversation: Conversation): Promise<CommandResult> {
  const workflowCwd = await resolveWorkflowCwd(conversation);
  try {
    const { workflows: reloadedWorkflows, errors: reloadErrors } =
      await discoverWorkflowsWithConfig(workflowCwd, loadConfig, providerRegistry);
    let msg = `Discovered ${String(reloadedWorkflows.length)} workflow(s).`;
    if (reloadErrors.length > 0) {
      msg += `\n\n**${String(reloadErrors.length)} failed to load:**\n`;
      for (const e of reloadErrors) {
        msg += `- \`${e.filename}\`: ${e.error}\n`;
      }
    }
    return { success: true, message: msg };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_reload_failed');
    return {
      success: false,
      message: `Failed to reload workflows: ${err.message}`,
    };
  }
}

function runWorkflow(input: WorkflowCommand): Promise<CommandResult> | CommandResult {
  const { conversation, args, surface } = input;
  const cmd = (command: string): string => spell(input, command);
  // Directly invoke a workflow by name (bypasses AI router)
  const workflowName = args[1];
  const restArgs = args.slice(2);
  const force = restArgs.includes('--force');
  const workflowArgs = restArgs.filter(arg => arg !== '--force').join(' ');

  if (!workflowName) {
    return {
      success: false,
      message: `Usage: ${cmd('run <name> [args]')}\n\nUse ${cmd('list')} to see available workflows.`,
    };
  }

  return startWorkflow(conversation, workflowName, workflowArgs, force, surface);
}

function workflowUsage(input: WorkflowCommand): CommandResult {
  const cmd = (command: string): string => spell(input, command);
  return {
    success: false,
    message: [
      'Usage:',
      `  ${cmd('list')} - Show available workflows`,
      `  ${cmd('reload')} - Reload workflow definitions`,
      `  ${cmd('status')} - Show all active workflows`,
      `  ${cmd('get <id>')} - Show one run, whatever its status`,
      `  ${cmd('cancel [id]')} - Cancel a running workflow (default: the one in this conversation)`,
      `  ${cmd('resume <id>')} - Resume a failed or paused run`,
      `  ${cmd('abandon <id>')} - Abandon a running, failed, or paused run`,
      `  ${cmd('approve <id> [comment]')} - Approve a paused gate`,
      `  ${cmd('reject <id> [reason]')} - Reject a paused gate`,
      `  ${cmd('reset-sessions <name> [<node-id>]')} - Clear persisted AI session memory for this conversation`,
      `  ${cmd('run <name> [args]')} - Run a workflow directly`,
    ].join('\n'),
  };
}

/** Workflow commands work with or without a project context. */
async function resolveWorkflowCwd(conversation: Conversation): Promise<string> {
  const codebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;
  return codebase ? (conversation.cwd ?? codebase.default_cwd) : getArchonWorkspacesPath();
}

/**
 * Resolve a workflow by name and return the request that starts it with `workflowArgs`
 * as its message. Chat reaches this through `/workflow run`; the run route calls it
 * directly so the message is never tokenized as a command.
 */
export async function startWorkflow(
  conversation: Conversation,
  workflowName: string,
  workflowArgs: string,
  force: boolean,
  surface: WorkflowCommandSurface
): Promise<CommandResult> {
  const cmd = (command: string): string => spellWorkflowCommand(surface, command);
  const workflowCwd = await resolveWorkflowCwd(conversation);

  getLog().debug(
    { workflowName, args: workflowArgs, cwd: workflowCwd },
    'cmd.workflow_run_invoked'
  );

  // Discover workflows with error handling
  let workflowEntries: readonly WorkflowWithSource[];
  let loadErrors: readonly WorkflowLoadError[];
  try {
    const result = await discoverWorkflowsWithConfig(workflowCwd, loadConfig, providerRegistry);
    workflowEntries = result.workflows;
    loadErrors = result.errors;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_discovery_failed');
    return {
      success: false,
      message: `Failed to load workflows: ${err.message}`,
    };
  }

  const workflows = workflowEntries.map(ws => ws.workflow);
  getLog().debug(
    {
      count: workflows.length,
      names: workflows.map(w => w.name),
      searchingFor: workflowName,
    },
    'cmd.workflows_discovered'
  );

  const workflow = resolveWorkflowName(workflowName, workflows);

  if (!workflow) {
    // Check if the requested workflow had a load error
    const loadError = findWorkflowLoadError(loadErrors, workflowName);
    if (loadError) {
      return {
        success: false,
        message: `Workflow \`${workflowName}\` failed to load: ${loadError.error}\n\nFix the YAML file and try again.`,
      };
    }
    getLog().warn(
      { requested: workflowName, available: workflows.map(w => w.name) },
      'cmd.workflow_not_found'
    );
    return {
      success: false,
      message: `Workflow \`${workflowName}\` not found.${
        workflows.length
          ? `\n\nDid you mean:\n${suggestWorkflowNames(workflowName, workflows)
              .map(name => `  - ${name}`)
              .join('\n')}`
          : ''
      }\n\nUse ${cmd('list')} to see available workflows.`,
    };
  }

  getLog().info({ workflow: workflow.name, args: workflowArgs }, 'cmd.workflow_starting');

  // Recover the discovery entry the `.map()` above dropped, so the keys the
  // engine ignores reach the conversation when the run STARTS — not only
  // when the author happens to browse `/workflow list` (#2213).
  const resolvedEntry = workflowEntries.find(ws => ws.workflow === workflow);

  // Return special result that triggers workflow execution in orchestrator
  return {
    success: true,
    message: `Starting workflow: \`${workflow.name}\``,
    workflow: {
      kind: 'start',
      definition: workflow,
      args: workflowArgs,
      force: force ? true : undefined,
      ...(resolvedEntry?.parseWarnings && resolvedEntry.parseWarnings.length > 0
        ? { parseWarnings: resolvedEntry.parseWarnings }
        : {}),
    },
  };
}
