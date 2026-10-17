import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import type { WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import type { Codebase } from '../types';
import { toError } from '../utils/error';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.chat_tools');
  return cachedLog;
}

export interface ProjectRegistration {
  projectName: string;
  projectPath: string;
  folder?: boolean;
}

/** A workflow launch the chat agent asked for, resolved and awaiting dispatch after the turn. */
export interface ChatLaunch {
  entry: WorkflowWithSource;
  codebase: Codebase;
  prompt: string;
}

/**
 * Find a codebase by exact name or by last path segment (e.g., "repo" matches "owner/repo").
 * Case-insensitive. Shared by the command scan and `invoke_workflow`, so both resolve a
 * project name the same way.
 */
export function findCodebaseByName(
  codebases: readonly Codebase[],
  projectName: string
): Codebase | undefined {
  const projectLower = projectName.toLowerCase();
  return codebases.find(c => {
    const nameLower = c.name.toLowerCase();
    return nameLower === projectLower || nameLower.endsWith(`/${projectLower}`);
  });
}

export const INVOKE_WORKFLOW_SCHEMA = defineNativeToolInputSchema({
  properties: {
    workflow: {
      kind: 'string',
      description: 'Exact workflow name from Available Workflows.',
    },
    project: {
      kind: 'string',
      description: 'Registered project NAME (e.g. "my-project"), not an ID or path.',
    },
    prompt: {
      kind: 'string',
      description:
        'Complete, self-contained task description that someone with no knowledge of this conversation could act on.',
    },
  },
  required: ['workflow', 'project', 'prompt'],
});

export interface InvokeWorkflowContext {
  workflows: readonly WorkflowWithSource[];
  /** Read at call time, so a project `register_project` created earlier in the turn resolves. */
  listCodebases: () => Promise<readonly Codebase[]>;
  /**
   * Queue the launch for dispatch after the turn ends. Returns `null` when accepted, or
   * the launch already queued this turn, which is kept and named in the refusal.
   */
  onLaunch: (launch: ChatLaunch) => ChatLaunch | null;
}

/**
 * The `invoke_workflow` native tool. Resolves the workflow and project at call time and
 * queues the launch; the orchestrator dispatches it once the turn ends, through the same
 * path the command scan uses, so gates, isolation hints and foreground/background choice
 * stay identical. Dispatching inside the call would block the agent loop for a whole
 * foreground workflow.
 */
export function buildInvokeWorkflowTool(ctx: InvokeWorkflowContext): NativeTool {
  return {
    name: 'invoke_workflow',
    description:
      'Launch a workflow on a registered project. The run starts after your reply ends; at most one launch per reply.',
    inputSchema: INVOKE_WORKFLOW_SCHEMA,
    handler: async (input): Promise<string> => {
      try {
        const workflowName = typeof input.workflow === 'string' ? input.workflow.trim() : '';
        const projectName = typeof input.project === 'string' ? input.project.trim() : '';
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        if (workflowName === '') return 'invoke_workflow: workflow is required.';
        if (projectName === '') return 'invoke_workflow: project is required.';
        if (prompt === '') return 'invoke_workflow: prompt is required.';

        // Exact name, as the command scan requires.
        const entry = ctx.workflows.find(w => w.workflow.name === workflowName);
        if (entry === undefined) {
          const names = ctx.workflows.map(w => w.workflow.name).join(', ');
          return `No workflow named "${workflowName}". Available: ${names || '(none)'}`;
        }
        const codebases = await ctx.listCodebases();
        const codebase = findCodebaseByName(codebases, projectName);
        if (codebase === undefined) {
          const names = codebases.map(c => c.name).join(', ');
          return `No registered project matches "${projectName}". Registered projects: ${names || '(none)'}`;
        }

        const queued = ctx.onLaunch({ entry, codebase, prompt });
        if (queued !== null) {
          return `Only one workflow launch per reply: ${queued.entry.workflow.name} on ${queued.codebase.name} is already queued. Nothing else was launched.`;
        }
        getLog().info(
          { workflowName: entry.workflow.name, codebaseId: codebase.id },
          'chat_tools.invoke_workflow_queued'
        );
        return `Queued ${entry.workflow.name} on ${codebase.name}. It starts when your reply ends; tell the user what you launched, and do not call invoke_workflow again this turn.`;
      } catch (e: unknown) {
        const err = toError(e);
        getLog().error({ err }, 'chat_tools.invoke_workflow_failed');
        return `invoke_workflow error: ${err.message}`;
      }
    },
  };
}

export const REGISTER_PROJECT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    name: { kind: 'string', description: 'Project name to register.' },
    path: { kind: 'string', description: 'Absolute path of the local directory.' },
    folder: {
      kind: 'boolean',
      description:
        'true only when the user explicitly wants a folder project that runs in place without Archon managing git.',
    },
  },
  required: ['name', 'path'],
});

/**
 * The `register_project` native tool. Registers inside the call, unlike `invoke_workflow`:
 * registration is quick and the agent may need the result to continue (clone, register,
 * then answer).
 */
export function buildRegisterProjectTool(ctx: {
  registerProject: (registration: ProjectRegistration) => Promise<string>;
}): NativeTool {
  return {
    name: 'register_project',
    description: 'Register an existing local directory as an Archon project.',
    inputSchema: REGISTER_PROJECT_SCHEMA,
    handler: async (input): Promise<string> => {
      const projectName = typeof input.name === 'string' ? input.name.trim() : '';
      const projectPath = typeof input.path === 'string' ? input.path.trim() : '';
      if (projectName === '') return 'register_project: name is required.';
      if (projectPath === '') return 'register_project: path is required.';
      try {
        return await ctx.registerProject({
          projectName,
          projectPath,
          ...(input.folder === true ? { folder: true } : {}),
        });
      } catch (e: unknown) {
        const err = toError(e);
        getLog().error({ err, projectName }, 'chat_tools.register_project_failed');
        return `Could not register project: ${err.message}`;
      }
    },
  };
}
