import type { NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { listDashboardRuns, findWorkflowRunsByIdPrefix } from '../db/workflows';
import {
  abandonWorkflow,
  approveWorkflow,
  rejectWorkflow,
  resumeWorkflow,
} from '../operations/workflow-operations';

const log = createLogger('orchestrator.manage_run');

export interface ManageRunContext {
  /** The project (codebase) this chat is scoped to. */
  codebaseId: string;
  /**
   * Launch a workflow in the background and return a user-facing result line
   * (including a friendly error for an unknown name). Omitted when the dispatch
   * context isn't available — `start` is then rejected.
   */
  startWorkflow?: (workflowName: string, message: string) => Promise<string>;
}

/**
 * Actions that require an explicit `confirm: true` before they run. `cancel`
 * and `abandon` are irreversible (the run becomes cancelled); `approve` and
 * `reject` are gated because a human gate stays a human decision even when an
 * agent is driving. `resume` is intentionally NOT here — it only validates
 * eligibility and changes nothing, so it's recoverable. Without confirm the
 * tool returns a preview and asks the agent to check with the user first: a
 * model-visible two-step that creates an audit point and a natural place to
 * involve the human, since there is no mid-turn UI-confirm primitive to block on.
 */
const DESTRUCTIVE_ACTIONS = new Set(['cancel', 'abandon', 'approve', 'reject']);

/** Of the destructive actions, the two that decide a paused human gate. */
const GATE_ACTIONS = new Set(['approve', 'reject']);

/** Every action the tool understands, in catalog order. */
const ACTIONS = [
  'help',
  'list',
  'get',
  'start',
  'resume',
  'cancel',
  'abandon',
  'approve',
  'reject',
] as const;
type Action = (typeof ACTIONS)[number];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...ACTIONS],
      description:
        "What to do. Call action='help' (optionally with subtool=<action>) to see exactly what each action needs before using it.",
    },
    subtool: {
      type: 'string',
      description:
        "For action=help: the action to describe (e.g. 'approve'). Omit for an overview.",
    },
    runId: {
      type: 'string',
      description:
        'Run id — required for get/resume/cancel/abandon/approve/reject. Accepts the short (8-char) or full id.',
    },
    workflow: {
      type: 'string',
      description: 'Workflow name to launch — required for action=start.',
    },
    message: {
      type: 'string',
      description:
        'Free text whose meaning depends on the action: start=the prompt/instructions; approve=optional comment; reject=the reason.',
    },
    confirm: {
      type: 'boolean',
      description:
        'Required (true) to actually perform a destructive action (cancel/abandon/approve/reject). Omit first to get a preview.',
    },
  },
  required: ['action'],
};

// ─── Progressive-disclosure help text ───────────────────────────────────────

const HELP_OVERVIEW = [
  'manage_run — inspect and operate this project’s workflow runs.',
  '',
  'Actions (call action=help subtool=<name> for details):',
  '  list     — recent runs in this project (id, workflow, status, step). No params.',
  '  get      — one run’s detail. Params: runId.',
  '  start    — launch a workflow in the background. Params: workflow, message.',
  '  resume   — check a failed/paused run can resume from completed nodes. Params: runId.',
  '  cancel   — mark a running run cancelled. Params: runId, confirm=true.',
  '  abandon  — discard a paused/failed run. Params: runId, confirm=true.',
  '  approve  — approve a paused human gate. Params: runId, message=comment, confirm=true.',
  '  reject   — reject a paused human gate. Params: runId, message=reason, confirm=true.',
  '',
  'Destructive actions (cancel/abandon/approve/reject) need confirm=true; call once',
  'without it to preview, confirm with the user, then call again with confirm=true.',
].join('\n');

const HELP_BY_ACTION: Record<Exclude<Action, 'help'>, string> = {
  list: 'list — recent runs for this project, most recent first. No parameters. Returns id · workflow · status · current step.',
  get: 'get — full detail for one run. Required: runId (short or full). Returns status, start/finish times, and error if any. Scoped to this project.',
  start:
    'start — launch a workflow in the background. Required: workflow (name). Recommended: message (what it should do). It appears in the runs list and the workflow dock.',
  resume:
    'resume — validate that a failed/paused run can resume from its completed nodes. Required: runId. Does NOT re-run it — it stays in its current status; continue it from the run’s controls or by re-invoking the workflow.',
  cancel:
    'cancel — mark a running (non-terminal) run cancelled. Required: runId, confirm=true. Irreversible. A process already executing may finish its current step before it stops.',
  abandon:
    'abandon — discard a paused/failed (non-terminal) run. Required: runId, confirm=true. Irreversible: the run becomes cancelled.',
  approve:
    'approve — approve a paused human gate so the run can continue. Required: runId, confirm=true. Optional: message (comment recorded with the approval). Only paused runs with an approval gate.',
  reject:
    'reject — reject a paused human gate. Required: runId, confirm=true. Recommended: message (the reason). If the gate has an on-reject prompt the run reworks; otherwise it is cancelled.',
};

/**
 * The `manage_run` native tool. Lets a project-scoped chat agent inspect and
 * operate this project’s workflow runs — list/get (read), start (launch), and
 * the lifecycle writes resume/cancel/abandon/approve/reject — without the user
 * typing slash commands.
 *
 * Design:
 *  - One tool, an `action` discriminator, and a `help` action for progressive
 *    disclosure (the model learns each action’s params on demand, keeping the
 *    tool surface small).
 *  - Writes mutate state through the same core `workflow-operations` functions
 *    the CLI and command-handler use — identical, proven semantics.
 *  - Every by-id action is project-scoped via `getScopedRun`, so an agent in
 *    one project cannot read or mutate another project’s run.
 *  - Destructive actions are gated on `confirm: true` (see DESTRUCTIVE_ACTIONS).
 *
 * The handler closes over the live `codebaseId`, so `@archon/providers` never
 * imports core — the tool crosses the boundary as data on SendQueryOptions.
 * Errors are caught and returned as text; nothing throws into the agent loop.
 */
export function buildManageRunTool(ctx: ManageRunContext): NativeTool {
  return {
    name: 'manage_run',
    description:
      "Inspect and operate this project's workflow runs (list, get, start, resume, cancel, abandon, approve, reject). Call action='help' first to see what each action needs. Destructive actions require confirm=true.",
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      // Switch on the raw string; unknown values fall through to `default`. No
      // assertion to `Action` — the switch's case labels narrow it for us.
      const action = typeof input.action === 'string' ? input.action : '';
      try {
        switch (action) {
          case 'help':
            return handleHelp(typeof input.subtool === 'string' ? input.subtool.trim() : '');
          case 'list':
            return await handleList(ctx);
          case 'get': {
            const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
            if (runId === '') return 'manage_run: action=get requires a runId.';
            const run = await getScopedRun(runId, ctx);
            return typeof run === 'string' ? run : formatRunDetail(run);
          }
          case 'start':
            return await handleStart(ctx, input);
          case 'resume':
          case 'cancel':
          case 'abandon':
          case 'approve':
          case 'reject':
            return await handleWrite(ctx, action, input);
          default:
            return `manage_run: unknown action '${action}'. Call action=help for the list.`;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const runId = typeof input.runId === 'string' ? input.runId : undefined;
        log.error({ err: e, action, runId, codebaseId: ctx.codebaseId }, 'manage_run.failed');
        return `manage_run error: ${msg}`;
      }
    },
  };
}

// ─── Read handlers ──────────────────────────────────────────────────────────

function handleHelp(subtool: string): string {
  if (subtool === '') return HELP_OVERVIEW;
  const detail = HELP_BY_ACTION[subtool as Exclude<Action, 'help'>];
  if (detail === undefined) {
    return `manage_run: no help for '${subtool}'. Known actions: ${Object.keys(HELP_BY_ACTION).join(', ')}.`;
  }
  return detail;
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

function formatRunDetail(run: WorkflowRun): string {
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

// ─── Write handlers ─────────────────────────────────────────────────────────

async function handleStart(ctx: ManageRunContext, input: Record<string, unknown>): Promise<string> {
  if (ctx.startWorkflow === undefined) {
    return 'manage_run: launching workflows is not available in this context.';
  }
  const workflow = typeof input.workflow === 'string' ? input.workflow.trim() : '';
  if (workflow === '') return 'manage_run: action=start requires a workflow name.';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  log.info({ codebaseId: ctx.codebaseId, workflow }, 'manage_run.start_requested');
  return await ctx.startWorkflow(workflow, message);
}

/** resume / cancel / abandon / approve / reject — all by-id, project-scoped. */
async function handleWrite(
  ctx: ManageRunContext,
  action: 'resume' | 'cancel' | 'abandon' | 'approve' | 'reject',
  input: Record<string, unknown>
): Promise<string> {
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  if (runId === '') return `manage_run: action=${action} requires a runId.`;

  const run = await getScopedRun(runId, ctx);
  if (typeof run === 'string') return run; // not found / wrong project

  // Destructive actions need explicit confirmation. Without it, preview only.
  if (DESTRUCTIVE_ACTIONS.has(action) && input.confirm !== true) {
    log.info({ runId: run.id, action }, 'manage_run.confirm_preview');
    const subject = GATE_ACTIONS.has(action)
      ? `the paused human gate on run ${run.id.slice(0, 8)} (${run.workflow_name})`
      : `run ${run.id.slice(0, 8)} (${run.workflow_name}), currently '${run.status}' — irreversible`;
    return (
      `⚠️ This will ${action} ${subject}. ` +
      'Confirm with the user, then call manage_run again with confirm: true to proceed.'
    );
  }

  const message = typeof input.message === 'string' ? input.message.trim() : '';
  log.info({ runId: run.id, action }, 'manage_run.write_requested');

  // Use the verified full id from `getScopedRun`, not the (possibly short) input
  // — the operations below look runs up by exact id.
  const id = run.id;
  switch (action) {
    case 'resume': {
      const resumed = await resumeWorkflow(id);
      return (
        `Run ${resumed.id.slice(0, 8)} (${resumed.workflow_name}) can resume from its completed ` +
        'nodes. It does not restart automatically — continue it from the run’s controls or by ' +
        're-invoking the workflow.'
      );
    }
    case 'cancel':
    case 'abandon': {
      const cancelled = await abandonWorkflow(id);
      return `Cancelled run ${cancelled.id.slice(0, 8)} (${cancelled.workflow_name}).`;
    }
    case 'approve': {
      const result = await approveWorkflow(id, message.length > 0 ? message : undefined);
      return result.type === 'interactive_loop'
        ? `Loop input recorded for ${result.workflowName} (${id.slice(0, 8)}). The run is now set to resume.`
        : `Approved ${result.workflowName} (${id.slice(0, 8)}). The run is now set to resume.`;
    }
    case 'reject': {
      const result = await rejectWorkflow(id, message.length > 0 ? message : undefined);
      if (result.cancelled) {
        const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
        return `Rejected and cancelled ${result.workflowName} (${id.slice(0, 8)})${suffix}.`;
      }
      return `Rejected ${result.workflowName} (${id.slice(0, 8)}). It will rework with your feedback when it resumes.`;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a run id — the short prefix shown in listings OR a full id — to a run
 * in THIS chat's project. The lookup is scoped to `codebaseId` in the query, so
 * an agent in project A can never read or mutate project B's runs: a foreign id
 * simply resolves to nothing. Returns the run, or a user-facing string on miss
 * or ambiguous prefix.
 */
async function getScopedRun(runId: string, ctx: ManageRunContext): Promise<WorkflowRun | string> {
  const matches = await findWorkflowRunsByIdPrefix(runId, ctx.codebaseId);
  if (matches.length > 1) {
    return `manage_run: id '${runId}' matches more than one run — use more characters or the full id.`;
  }
  const [run] = matches;
  if (run === undefined) {
    return `manage_run: no run found for id '${runId}' in this project.`;
  }
  return run;
}
