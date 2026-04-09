/**
 * Workflow MCP Tool — in-process MCP server for orchestrator sessions.
 *
 * Registers a single `invoke_workflow` tool that Claude can call natively,
 * replacing the fragile `/invoke-workflow` text-parsing approach.
 */
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import { findWorkflow } from '@archon/workflows/router';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { Codebase, IPlatformAdapter, HandleMessageContext, Conversation } from '../types';
import { findCodebaseByName } from './codebase-utils';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow-tool');
  return cachedLog;
}

export interface WorkflowToolDeps {
  platform: IPlatformAdapter;
  conversationId: string;
  conversation: Conversation;
  codebases: readonly Codebase[];
  workflows: readonly WorkflowDefinition[];
  isolationHints?: HandleMessageContext['isolationHints'];
  dispatch: (
    codebase: Codebase,
    workflow: WorkflowDefinition,
    taskDescription: string
  ) => Promise<void>;
}

/**
 * Build an in-process MCP server with a single `invoke_workflow` tool.
 * Pass the returned value in `requestOptions.mcpServers` on each `sendQuery` call.
 */
export function buildWorkflowMcpServer(deps: WorkflowToolDeps): McpSdkServerConfigWithInstance {
  const workflowTool = tool(
    'invoke_workflow',
    'Dispatch an Archon workflow for a registered project. Use this when the user wants structured development work (e.g. fix an issue, implement a feature, create a plan). The workflow runs in the background — this tool returns immediately.',
    {
      workflow_name: z
        .string()
        .describe('Exact workflow name (e.g., "archon-fix-github-issue-dag", "archon-assist")'),
      project_name: z.string().describe('Project name (e.g., "remote-coding-agent")'),
      task_description: z
        .string()
        .min(1, 'task_description cannot be empty')
        .describe(
          'Complete, self-contained description of the task. Must make sense with NO knowledge of this conversation. Do NOT use vague references like "do what we discussed".'
        ),
    },
    async (
      args: { workflow_name: string; project_name: string; task_description: string },
      _extra: unknown
    ) => {
      const workflow = findWorkflow(args.workflow_name, [...deps.workflows]);
      if (!workflow) {
        const available = deps.workflows.map(w => w.name).join(', ') || 'none';
        return {
          content: [
            {
              type: 'text',
              text: `Error: workflow "${args.workflow_name}" not found. Available workflows: ${available}`,
            },
          ],
        };
      }

      const codebase = findCodebaseByName(deps.codebases, args.project_name);
      if (!codebase) {
        const available = deps.codebases.map(c => c.name).join(', ') || 'none';
        return {
          content: [
            {
              type: 'text',
              text: `Error: project "${args.project_name}" not found. Registered projects: ${available}`,
            },
          ],
        };
      }

      // Fire-and-forget — handler returns immediately; workflow runs in background
      void deps.dispatch(codebase, workflow, args.task_description).catch((err: unknown) => {
        getLog().error(
          {
            err,
            workflowName: workflow.name,
            codebaseName: codebase.name,
            conversationId: deps.conversationId,
          },
          'workflow_dispatch_error'
        );
        // Notify user — fire-and-forget failure must not be silent
        void deps.platform.sendMessage(
          deps.conversationId,
          `⚠️ Failed to start workflow \`${workflow.name}\` for \`${codebase.name}\`. Check server logs or use \`/reset\` to start fresh.`
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `Dispatched workflow ${workflow.name} for project ${codebase.name}. It is now running in the background.`,
          },
        ],
      };
    }
  );

  return createSdkMcpServer({
    name: 'archon-tools',
    version: '1.0.0',
    tools: [workflowTool],
  });
}
