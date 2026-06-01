import type { NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import { listDashboardRuns, getWorkflowRun } from '../db/workflows';

const log = createLogger('orchestrator.manage_run');

export interface ManageRunContext {
  /** The project (codebase) this chat is scoped to. */
  codebaseId: string;
}

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'get'],
      description:
        "What to do: 'list' = recent workflow runs for this project and their status; 'get' = one run's detail.",
    },
    runId: {
      type: 'string',
      description: 'Run id — required for action=get. Accepts the short (8-char) or full id.',
    },
  },
  required: ['action'],
};

/**
 * The `manage_run` native tool (Wave 1, read-only). Lets the chat agent see this
 * project's workflow runs so it can answer "what's running?" / "did the review
 * pass?" without the user typing slash commands.
 *
 * Read-only by design: `list` and `get` only. Start/cancel/approve/reject are
 * later increments (start needs dispatch wiring; the destructive writes need a
 * mid-turn confirmation primitive that doesn't exist yet).
 *
 * The handler closes over the live `codebaseId`, so `@archon/providers` never
 * imports core — the tool crosses the boundary as data on SendQueryOptions.
 * Errors are caught and returned as text; nothing throws into the agent loop.
 */
export function buildManageRunTool(ctx: ManageRunContext): NativeTool {
  return {
    name: 'manage_run',
    description:
      "Inspect this project's workflow runs. action=list shows recent runs (id, workflow, status, current step); action=get shows one run's detail (requires runId).",
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const action = typeof input.action === 'string' ? input.action : '';
      try {
        if (action === 'list') return await handleList(ctx);
        if (action === 'get') {
          const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
          if (runId === '') return 'manage_run: action=get requires a runId.';
          return await handleGet(runId);
        }
        return `manage_run: unknown action '${action}'. Valid actions: list, get.`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: e, action, codebaseId: ctx.codebaseId }, 'manage_run.failed');
        return `manage_run error: ${msg}`;
      }
    },
  };
}

async function handleList(ctx: ManageRunContext): Promise<string> {
  const { runs } = await listDashboardRuns({ codebaseId: ctx.codebaseId, limit: 20 });
  log.info({ codebaseId: ctx.codebaseId, count: runs.length }, 'manage_run.list_completed');
  if (runs.length === 0) return 'No workflow runs for this project yet.';

  const lines = runs.map(r => {
    const step =
      r.current_step_name !== null
        ? ` · ${r.current_step_name}${r.total_steps !== null ? `/${r.total_steps.toString()}` : ''}`
        : '';
    return `- ${r.id.slice(0, 8)} · ${r.workflow_name} · ${r.status}${step}`;
  });
  return `${runs.length.toString()} run(s) (most recent first):\n${lines.join('\n')}`;
}

async function handleGet(runId: string): Promise<string> {
  const run = await getWorkflowRun(runId);
  if (run === null) return `manage_run: no run found for id '${runId}'.`;

  const parts = [
    `Run ${run.id.slice(0, 8)} · ${run.workflow_name}`,
    `status: ${run.status}`,
    `started: ${run.started_at.toISOString()}`,
  ];
  if (run.completed_at !== null) parts.push(`finished: ${run.completed_at.toISOString()}`);
  const error = run.metadata.error;
  if (typeof error === 'string' && error.length > 0) parts.push(`error: ${error.slice(0, 300)}`);
  log.info({ runId: run.id, status: run.status }, 'manage_run.get_completed');
  return parts.join('\n');
}
