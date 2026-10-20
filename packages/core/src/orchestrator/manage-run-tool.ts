import type { RunActor } from '../operations/run-authorization';
import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import {
  attentionLabels,
  attentionRevision,
  isApprovalContext,
  isContainerRun,
  legacyOccurrenceStep,
  pausedAttentionWait,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import { attentionLabelKeySchema, attentionLabelsSchema } from '@archon/workflows/schemas/dag-node';
import { z } from 'zod';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type { RunAttention, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { toError } from '../utils/error';
import {
  CancelRefusedError,
  workflowOperationErrorMessage,
  describeAbandonOwner,
  expectedGateForOccurrence,
} from '../operations/workflow-operations';
import type { GateAnswerOrigin, WorkflowOperations } from '../operations/workflow-operations';

const log = createLogger('orchestrator.manage_run');

export interface ManageRunContext {
  actor: RunActor;
  operations: Pick<
    WorkflowOperations,
    | 'abandonWorkflow'
    | 'cancelWorkflow'
    | 'approveWorkflow'
    | 'rejectWorkflow'
    | 'respondToWorkflow'
    | 'answerWorkflow'
    | 'labelAttentionWait'
    | 'resumeWorkflow'
    | 'listWorkflowRuns'
    | 'findWorkflowRunsByIdPrefix'
  >;
  /** The project (codebase) this chat is scoped to. */
  codebaseId: string;
  /**
   * Continuation seam for a gate the agent just resolved. Called with the run
   * reloaded AFTER the committed decision leaves it resumable
   * — never for a reject that cancelled the run, which is already terminal.
   *
   * Resolving a gate and continuing the run are two halves of one user action:
   * a tool that only did the first would leave every gate the agent resolves
   * stranded (#2565). The orchestrator registers this and drives the resume
   * AFTER the agent's turn ends, so the tool call returns promptly instead of
   * blocking the agent loop on a whole workflow.
   *
   * Returns whether it accepted the run — a turn continues ONE run, so a second
   * gate resolved in the same turn is declined and told to resume manually. Any
   * false answer must reach the agent as words, or the run is stranded silently.
   *
   * Synchronous and non-throwing by contract — it records intent, it does not
   * perform the resume. Omitted when the caller has no way to continue a run;
   * the tool then says so rather than implying the run moves on by itself.
   */
  onGateResolved?: (run: WorkflowRun, action: 'approve' | 'reject' | 'respond') => boolean;
  /**
   * The surface the agent's answer reaches. Spells the commands the tool tells the
   * agent to hand the user. Omitted means the chat grammar, `/workflow <command>`.
   */
  surface?: WorkflowCommandSurface;
}

/**
 * Actions that require an explicit `confirm: true` before they run. `cancel`
 * and `abandon` are irreversible (the run becomes cancelled); `approve`,
 * `reject`, and `respond` are gated because answering a pause stays the user's
 * decision even when an agent is driving. `resume` is intentionally NOT here — it only
 * validates eligibility and changes nothing, so it's recoverable. Without
 * confirm the tool returns a preview and asks the agent to check with the user
 * first: a model-visible two-step that creates an audit point and a natural
 * place to involve the human, since there is no mid-turn UI-confirm primitive
 * to block on.
 */
const DESTRUCTIVE_ACTIONS = new Set(['cancel', 'abandon', 'approve', 'reject', 'respond']);

/** Of the destructive actions, the ones that answer a paused gate or attention wait. */
const GATE_ACTIONS = new Set(['approve', 'reject', 'respond']);

/** Every action the tool understands, in catalog order. */
const ACTIONS = [
  'help',
  'list',
  'get',
  'resume',
  'cancel',
  'abandon',
  'approve',
  'reject',
  'respond',
  'label',
] as const;
type Action = (typeof ACTIONS)[number];

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    action: {
      kind: 'enum',
      values: [...ACTIONS],
      description:
        "What to do. Call action='help' (optionally with subtool=<action>) to see exactly what each action needs before using it.",
    },
    subtool: {
      kind: 'string',
      description:
        "For action=help: the action to describe (e.g. 'approve'). Omit for an overview.",
    },
    runId: {
      kind: 'string',
      description:
        'Run id — required for get/resume/cancel/abandon/approve/reject/respond/label. Accepts the short (8-char) or full id.',
    },
    decision: {
      kind: 'string',
      description:
        "Required for action=respond: the decision id the paused gate declared, or the option id of a paused attention wait (call action=get to see them — the run detail lists 'gate: decisions: ...' or the wait's options when applicable). 'approve'/'reject' work here too, but prefer the dedicated approve/reject actions for those — respond is for a gate whose declared decisions include something else (e.g. 'revise', 'escalate'). An id the gate did not declare fails with the actual options.",
    },
    decisions: {
      kind: 'string',
      description:
        'For action=respond at a multi_select attention wait, instead of decision: a JSON array of the option ids to choose, e.g. ["lint","tests"]. Each id must be one of the wait\'s options and appear once.',
    },
    message: {
      kind: 'string',
      description:
        'Free text whose meaning depends on the action: approve=optional comment; reject=the reason; respond=text recorded alongside the decision.',
    },
    confirm: {
      kind: 'boolean',
      description:
        'Required (true) to actually perform a destructive action (cancel/abandon/approve/reject/respond). Omit first to get a preview.',
    },
    occurrence: {
      kind: 'string',
      description:
        "For approve/reject/respond: the occurrence of the gate or attention wait your answer is for, as action=get reports it ('occurrence: ...'). When given, the answer is refused if the run has since moved to a different pause. Required for label.",
    },
    set: {
      kind: 'string',
      description:
        'For action=label: a JSON object of labels to set, string to string, e.g. {"class":"ci-other"}. A key already present is replaced.',
    },
    unset: {
      kind: 'string',
      description: 'For action=label: a JSON array of label keys to remove, e.g. ["urgency"].',
    },
    // accept deliberately WINS over a simultaneous message (the message is
    // discarded, not recorded): an agent that reflexively attaches a comment to
    // every approve must still be able to force finalize — that footgun is the
    // reason this arg exists (#2074).
    accept: {
      kind: 'boolean',
      description:
        'For action=approve on an interactive-loop gate with completionSignaled=true: accept=true finalizes the node from the already-computed output WITHOUT re-running, regardless of any message (a simultaneous message is discarded, not recorded). Omit and pass message=<feedback> to run another iteration instead.',
    },
  },
  required: ['action'],
});

// ─── Progressive-disclosure help text ───────────────────────────────────────

const HELP_OVERVIEW = [
  'manage_run — inspect and operate this project’s workflow runs.',
  '',
  'Actions (call action=help subtool=<name> for details):',
  '  list     — recent runs in this project (id, workflow, status, authored outcome, active nodes). No params.',
  '  get      — one run’s detail. Params: runId.',
  '  resume   — check a failed/paused run can resume from completed nodes. Params: runId.',
  '  cancel   — stop a running run. Params: runId, confirm=true.',
  '  abandon  — discard a paused/failed run. Params: runId, confirm=true.',
  '  approve  — approve a paused gate or attention wait. Params: runId, confirm=true, optional accept/message.',
  '  reject   — reject a paused gate or attention wait. Params: runId, message=reason, confirm=true.',
  '  respond  — answer a paused gate or attention wait with any declared decision or option (get shows them). Params: runId, decision (or decisions for a multi_select wait), confirm=true, optional message.',
  '  label    — set or remove labels on a paused attention wait. Params: runId, occurrence, set and/or unset.',
  '',
  'Destructive actions (cancel/abandon/approve/reject/respond) need confirm=true; call once',
  'without it to preview, confirm with the user, then call again with confirm=true.',
].join('\n');

const HELP_BY_ACTION: Record<Exclude<Action, 'help'>, string> = {
  list: 'list — recent runs for this project, most recent first. No parameters. Returns id · workflow · status · authored outcome when declared · active node(s).',
  get: 'get — full detail for one run. Required: runId (short or full). Returns status, authored outcome when declared, start/finish times, and error if any. Scoped to this project.',
  resume:
    'resume — validate that a failed/paused run can resume from its completed nodes. Required: runId. Does NOT re-run it — it stays in its current status; continue it from the run’s controls or by re-invoking the workflow.',
  cancel:
    'cancel — stop a running run. Required: runId, confirm=true. Irreversible. A run this server executes stops at its next status check; a run another process owns has that process stopped first. When no owner answers, cancel refuses and leaves the run unchanged; abandon is the way to release it once the user confirms its process is gone.',
  abandon:
    'abandon — discard a paused/failed (non-terminal) run. Required: runId, confirm=true. Irreversible: the run becomes cancelled.',
  approve:
    'approve — approve a paused gate or attention wait; the run then continues on its own (no separate resume). Required: runId, confirm=true. Optional: accept, message. On an interactive loop whose gate shows completionSignaled=true: NO message (or accept=true) FINALIZES the node from the already-computed output without re-running; message=<feedback> runs another iteration with it. On other gates, message is just a comment recorded with the approval — pass the user’s own words, since a gate with capture_response reads it as the node’s output. At an attention wait, approve chooses its `approve` option, or answers a message wait with message as the text. Only paused runs with an approval gate or an attention wait that accepts approve.',
  reject:
    'reject — reject a paused gate or attention wait. Required: runId, confirm=true. Recommended: message (the reason, in the user’s own words). If the gate has an on-reject prompt the run reworks and continues on its own; otherwise it is cancelled and nothing further runs. At an attention wait, reject chooses its `reject` option and never cancels: the run continues and the next node reads the answer.',
  label:
    'label — set or remove labels on the attention wait a run is paused at, without answering it. Required: runId, occurrence (as action=get reports it), and set (a JSON object of string labels) and/or unset (a JSON array of keys). A set key replaces the same key; other labels stay. Refused when the run has moved to another pause. Labels are plain data the engine never interprets; they let the user’s own handlers find their items.',
  respond:
    "respond — answer a paused gate with any decision it declared, or an attention wait with one of its options, not just approve/reject. Required: runId, confirm=true, and decision (or, at a multi_select attention wait, decisions: a JSON array of option ids). Optional: message (text recorded alongside the decision). Call action=get first — the run detail lists the gate’s declared decisions when it has more than the default pair. decision='approve'/'reject' also works here, but prefer the dedicated approve/reject actions for those; use respond for anything else the gate declared (e.g. 'revise', 'escalate'). An id the gate did not declare fails and names the actual options — nothing is silently cancelled.",
};

/**
 * The `manage_run` native tool. Lets a project-scoped chat agent inspect and
 * operate this project’s workflow runs — list/get (read) and
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
      "Inspect and operate this project's workflow runs (list, get, resume, cancel, abandon, approve, reject, respond, label). Call action='help' first to see what each action needs. Destructive actions require confirm=true.",
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
          case 'resume':
          case 'cancel':
          case 'abandon':
          case 'approve':
          case 'reject':
          case 'respond':
            return await handleWrite(ctx, action, input);
          case 'label':
            return await handleLabel(ctx, input);
          default:
            return `manage_run: unknown action '${action}'. Call action=help for the list.`;
        }
      } catch (e: unknown) {
        const msg = workflowOperationErrorMessage(e, ctx.surface ?? {});
        const runId = typeof input.runId === 'string' ? input.runId : undefined;
        log.error({ err: e, action, runId, codebaseId: ctx.codebaseId }, 'manage_run.failed');
        return `manage_run error: ${msg}`;
      }
    },
  };
}

/** How this tool answers an attention wait of each form. */
function attentionAnswerAdvice(attention: Extract<RunAttention, { kind: 'attention' }>): string {
  // A wait paused before answers existed; only resume moves it.
  if (legacyOccurrenceStep(attention.occurrence) !== undefined)
    return `when it is done, run \`archon workflow resume ${attention.runId}\`; abandon it if it should not continue.`;
  switch (attention.form) {
    case 'message':
      return 'answer with action=approve and message=<the answer>.';
    case 'approval':
      return 'answer with action=approve or action=reject, optionally with message=<text>; reject is an answer and does not cancel the run.';
    case 'select':
      return 'answer with action=respond, decision=<one of the options>, optionally with message=<text>.';
    case 'multi_select':
      return 'answer with action=respond, decisions=<JSON array of the option ids to choose, each at most once>, optionally with message=<text>.';
  }
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
  const { runs } = await ctx.operations.listWorkflowRuns({ codebaseId: ctx.codebaseId, limit: 20 });
  log.info({ codebaseId: ctx.codebaseId, count: runs.length }, 'manage_run.list_completed');
  if (runs.length === 0) return 'No workflow runs for this project yet.';

  const lines = runs.map(r => {
    const activeNodes =
      r.active_nodes.length > 0 ? ` · active node(s): ${r.active_nodes.join(', ')}` : '';
    const outcome = r.outcome ? ` · authored outcome: ${r.outcome}` : '';
    return `- ${r.id.slice(0, 8)} · ${r.workflow_name} · ${r.status}${outcome}${activeNodes}`;
  });
  return `${runs.length.toString()} run(s) (most recent first):\n${lines.join('\n')}`;
}

/**
 * Runtime-safe timestamp formatter. The run schema declares these fields as
 * Date, but rows are cast, never Zod-parsed: Postgres hydrates TIMESTAMPTZ
 * into Date objects while SQLite returns TEXT ('YYYY-MM-DD HH:MM:SS', UTC)
 * as-is (#2078). Mirrors the API serializer (routes/api-serializers.ts
 * toISOString): pass strings through verbatim — re-parsing with new Date()
 * would misread the UTC wall-clock string as local time — and format Dates.
 */
function formatTimestamp(val: Date | string): string {
  return typeof val === 'string' ? val : val.toISOString();
}

function formatRunDetail(run: WorkflowRun): string {
  const parts = [`Run ${run.id.slice(0, 8)} · ${run.workflow_name}`, `status: ${run.status}`];
  if (run.outcome !== null) parts.push(`authored outcome: ${run.outcome}`);
  parts.push(`started: ${formatTimestamp(run.started_at)}`);
  if (run.completed_at !== null) parts.push(`finished: ${formatTimestamp(run.completed_at)}`);
  const error = run.metadata.error;
  if (typeof error === 'string' && error.length > 0) parts.push(`error: ${error.slice(0, 300)}`);
  // Paused interactive-loop gate: surface the structured gate state (#2074) so an
  // AI approver can decide finalize-vs-iterate without parsing prose.
  const rawApproval = run.metadata.approval;
  const attention = runAttention(run);
  if (attention?.kind === 'awaiting_response' || attention?.kind === 'attention')
    parts.push(`occurrence: ${attention.occurrence}`);
  if (attention?.kind === 'stalled_tool_calls') {
    parts.push('provider turns or reported work need attention; work remains running');
    for (const call of attention.calls)
      parts.push(
        `${call.nodeId} · ${call.provider} · ${call.name}: ${call.title || call.name} (running ${Math.floor(call.elapsedMs / 1000)}s; no progress ${Math.floor(call.stalledForMs / 1000)}s)`
      );
    parts.push(
      `inspect with archon workflow logs ${run.id}; archon workflow end-turn ${run.id} records a request to end the stalled attempt; workflow wait checks progress or owner_lost, or explicitly cancel`
    );
  }
  if (attention?.kind === 'attention') {
    parts.push(`needs attention: ${attention.message.slice(0, 300)}`);
    parts.push(`form: ${attention.form}`);
    if (attention.options.length > 0)
      parts.push(`options: ${attention.options.map(option => option.id).join(', ')}`);
    const wait = pausedAttentionWait(run);
    if (wait !== undefined) {
      const labels = Object.entries(attentionLabels(wait));
      if (labels.length > 0)
        parts.push(`labels: ${labels.map(([key, value]) => `${key}=${value}`).join(', ')}`);
      parts.push(`revision: ${String(attentionRevision(wait))}`);
    }
    parts.push(`-> ${attentionAnswerAdvice(attention)}`);
  }
  if (
    run.status === 'paused' &&
    isApprovalContext(rawApproval) &&
    rawApproval.type === 'interactive_loop'
  ) {
    parts.push(
      `gate: awaiting approval (node ${rawApproval.nodeId}, iteration ${String(rawApproval.iteration ?? '?')})`
    );
    parts.push(`completionSignaled: ${rawApproval.completionSignaled === true ? 'true' : 'false'}`);
    if (rawApproval.completionSignaled === true) {
      parts.push(
        '-> approve with NO message (or accept:true) to FINALIZE without re-running; approve with a message to run another iteration.'
      );
    }
    const excerpt = (rawApproval.signaledOutput ?? '').trim().slice(0, 300);
    if (excerpt) parts.push(`output: ${excerpt}`);
  }
  // Paused gate with an author-declared decision vocabulary beyond approve/reject
  // (#2707 step 2) — surface it so the agent knows what action=respond accepts,
  // instead of guessing at a decision id.
  if (
    run.status === 'paused' &&
    isApprovalContext(rawApproval) &&
    (rawApproval.type === 'approval' || rawApproval.type === undefined) &&
    rawApproval.decisionsAuthored === true &&
    rawApproval.decisions !== undefined
  ) {
    const ids = rawApproval.decisions.map(d => d.id).join(', ');
    parts.push(`gate: decisions: ${ids} (use action=respond with one of these)`);
  }
  log.info({ runId: run.id, status: run.status }, 'manage_run.get_completed');
  return parts.join('\n');
}

// ─── Write handlers ─────────────────────────────────────────────────────────

/** resume / cancel / abandon / approve / reject / respond — all by-id, project-scoped. */
async function handleWrite(
  ctx: ManageRunContext,
  action: 'resume' | 'cancel' | 'abandon' | 'approve' | 'reject' | 'respond',
  input: Record<string, unknown>
): Promise<string> {
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  if (runId === '') return `manage_run: action=${action} requires a runId.`;

  const run = await getScopedRun(runId, ctx);
  if (typeof run === 'string') return run; // not found / wrong project

  const decision = typeof input.decision === 'string' ? input.decision.trim() : '';
  const decisions = parseDecisions(input);
  if (typeof decisions === 'string') return decisions;
  if (action === 'respond' && decision === '' && decisions === undefined) {
    return 'manage_run: action=respond requires a decision (call action=get to see the declared decisions or options).';
  }
  if (decision !== '' && decisions !== undefined) {
    return 'manage_run: pass either decision or decisions, not both.';
  }

  const message = typeof input.message === 'string' ? input.message.trim() : '';
  // A supplied occurrence is always checked, even when empty: an empty one matches no pause
  // and is refused as stale, as the CLI refuses `--occurrence ''`. Only an absent one skips it.
  const origin: GateAnswerOrigin = {
    via: 'manage_run',
    ...(typeof input.occurrence === 'string'
      ? { expectedGate: expectedGateForOccurrence(run, input.occurrence.trim()) }
      : {}),
  };
  // Single finalize-vs-iterate predicate for approve (#2074): accept=true or an
  // empty message means no feedback reaches the gate — used by both the confirm
  // preview and the write path so they can never disagree.
  const willFinalize = input.accept === true || message === '';

  // Destructive actions need explicit confirmation. Without it, preview only.
  if (DESTRUCTIVE_ACTIONS.has(action) && input.confirm !== true) {
    log.info({ runId: run.id, action }, 'manage_run.confirm_preview');
    const subject = GATE_ACTIONS.has(action)
      ? `the paused gate or attention wait on run ${run.id.slice(0, 8)} (${run.workflow_name})`
      : `run ${run.id.slice(0, 8)} (${run.workflow_name}), currently '${run.status}' — irreversible`;
    // For approve after an interactive-loop completion condition was met, tell the agent which
    // effect its current args would have (finalize vs iterate) so the confirmed
    // second call is deliberate (#2074).
    let effect = '';
    const approvalMeta = run.metadata.approval;
    if (
      action === 'approve' &&
      isApprovalContext(approvalMeta) &&
      approvalMeta.type === 'interactive_loop' &&
      approvalMeta.completionSignaled === true
    ) {
      effect = willFinalize
        ? ' A completion condition was met at this gate, and your args would FINALIZE the node from the already-computed output (no re-run).'
        : ' A completion condition was met at this gate, but your message would run ANOTHER iteration (pass accept:true or drop the message to finalize instead).';
    }
    return (
      `⚠️ This will ${action} ${subject}.${effect} ` +
      'Confirm with the user, then call manage_run again with confirm: true to proceed.'
    );
  }

  log.info({ runId: run.id, action }, 'manage_run.write_requested');

  // Use the verified full id from `getScopedRun`, not the (possibly short) input
  // — the operations below look runs up by exact id.
  const id = run.id;
  switch (action) {
    case 'resume': {
      const resumed = await ctx.operations.resumeWorkflow(id, ctx.actor);
      return (
        `Run ${resumed.id.slice(0, 8)} (${resumed.workflow_name}) can resume from its completed ` +
        'nodes. It does not restart automatically — continue it from the run’s controls or by ' +
        're-invoking the workflow.'
      );
    }
    case 'cancel': {
      try {
        const result = await ctx.operations.cancelWorkflow(id, ctx.actor);
        if (result.kind === 'cooperative') {
          return result.cancelled
            ? `Cancelled run ${id.slice(0, 8)} (${result.run.workflow_name}). Its executor stops at its next status check.`
            : `Run ${id.slice(0, 8)} (${result.run.workflow_name}) already finished; nothing to cancel.`;
        }
        let msg = `Stopped the run's live owner process (pid ${String(result.pid)}), then cancelled run ${id.slice(0, 8)} (${result.run.workflow_name}).`;
        for (const warning of result.cleanupWarnings ?? []) msg += ` Warning: ${warning}`;
        if (result.cascadeFailures > 0) {
          msg += ` Warning: ${String(result.cascadeFailures)} sub-run(s) could not be cancelled and may still be running.`;
        }
        if (result.blockedParentRunId) {
          msg += ` Parent run ${result.blockedParentRunId.slice(0, 8)} was blocked on this sub-run and stays paused — resume it so it reads this sub-run's outcome, or abandon it too.`;
        }
        return msg;
      } catch (error) {
        if (error instanceof CancelRefusedError && error.reason === 'no_owner_answered') {
          return `${error.message} To release it, call manage_run with action='abandon' once the user confirms its process is gone.`;
        }
        throw error;
      }
    }
    case 'abandon': {
      const {
        run: cancelled,
        cascadeFailures,
        cleanupWarnings,
        blockedParentRunId,
        owner,
      } = await ctx.operations.abandonWorkflow(id, ctx.actor);
      let msg = `${describeAbandonOwner(owner).join(' ')} Cancelled run ${cancelled.id.slice(0, 8)} (${cancelled.workflow_name}).`;
      for (const warning of cleanupWarnings ?? []) msg += ` Warning: ${warning}`;
      if (cascadeFailures > 0) {
        msg += ` Warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running.`;
      }
      if (blockedParentRunId) {
        msg += ` Parent run ${blockedParentRunId.slice(0, 8)} was blocked on this sub-run and stays paused — resume it so it reads this sub-run's outcome, or abandon it too.`;
      }
      return msg;
    }
    case 'approve': {
      // accept=true forces the finalize path (#2074): no feedback reaches the gate,
      // so a loop with a completed condition finalizes from its persisted output on resume.
      const feedback = willFinalize ? undefined : message;
      const result = await ctx.operations.approveWorkflow(id, feedback, ctx.actor, origin);
      const continues = await signalGateResolved(ctx, run, 'approve');
      if (result.type !== 'interactive_loop') {
        return `Approved ${result.workflowName} (${id.slice(0, 8)}).${continues}`;
      }
      return feedback === undefined
        ? `Approved ${result.workflowName} (${id.slice(0, 8)}) with no feedback. If the gate paused after a completion condition was met, the node finalizes from its computed output (no re-run); otherwise the loop runs another iteration.${continues}`
        : `Feedback recorded for ${result.workflowName} (${id.slice(0, 8)}); the loop runs another iteration with it.${continues}`;
    }
    case 'reject': {
      const result = await ctx.operations.rejectWorkflow(id, message, ctx.actor, origin);
      if (result.cancelled) {
        const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
        return `Rejected and cancelled ${result.workflowName} (${id.slice(0, 8)})${suffix}. Nothing further runs.`;
      }
      const continues = await signalGateResolved(ctx, run, 'reject');
      return `Rejected ${result.workflowName} (${id.slice(0, 8)}).${continues}`;
    }
    case 'respond': {
      if (decisions !== undefined) {
        // Several options for a multi_select wait. The operation validates them against the
        // wait's declared options and refuses an unknown or repeated id, naming the valid ones.
        await ctx.operations.answerWorkflow(
          id,
          { choose: decisions, ...(message !== '' ? { text: message } : {}) },
          ctx.actor,
          origin
        );
        const continues = await signalGateResolved(ctx, run, 'respond');
        return `Responded ${decisions.map(option => `'${option}'`).join(', ')} to ${run.workflow_name} (${id.slice(0, 8)}).${continues}`;
      }
      // Any decision the gate declared, not just approve/reject (#2707 step 2).
      // respondToWorkflow validates `decision` itself and throws a clear error
      // naming the gate's actual options on a mismatch — caught by the tool's
      // outer try/catch and returned as text, never a silent no-op.
      const result = await ctx.operations.respondToWorkflow(
        id,
        decision,
        message,
        ctx.actor,
        origin
      );
      if ('cancelled' in result) {
        // decision === 'reject' resolved through the legacy cancel/rework path.
        if (result.cancelled) {
          const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
          return `Rejected and cancelled ${result.workflowName} (${id.slice(0, 8)})${suffix}. Nothing further runs.`;
        }
        const continues = await signalGateResolved(ctx, run, 'respond');
        return `Rejected ${result.workflowName} (${id.slice(0, 8)}).${continues}`;
      }
      const continues = await signalGateResolved(ctx, run, 'respond');
      return `Responded '${decision}' to ${result.workflowName} (${id.slice(0, 8)}).${continues}`;
    }
  }
}

const decisionsSchema = z.array(z.string().min(1)).min(1);

/** The `decisions` parameter: undefined when absent, the option ids, or a message naming the problem. */
function parseDecisions(input: Record<string, unknown>): string[] | string | undefined {
  const raw = input.decisions;
  if (raw === undefined) return undefined;
  const problem =
    'manage_run: decisions must be a JSON array of option ids, e.g. ["lint","tests"].';
  if (typeof raw !== 'string') return problem;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return problem;
  }
  const parsed = decisionsSchema.safeParse(value);
  return parsed.success ? parsed.data : problem;
}

const labelKeysSchema = z.array(attentionLabelKeySchema);

/** Parse one JSON-valued label parameter, naming it when it does not match its schema. */
function parseLabelParam<T>(
  input: Record<string, unknown>,
  name: 'set' | 'unset',
  schema: z.ZodType<T>,
  empty: T
): T | string {
  const raw = input[name];
  if (raw === undefined) return empty;
  if (typeof raw !== 'string') return `manage_run: ${name} must be a JSON string.`;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return `manage_run: ${name} is not valid JSON.`;
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? parsed.data
    : name === 'set'
      ? 'manage_run: set must be a JSON object whose keys have no "=" or whitespace and whose values are strings.'
      : 'manage_run: unset must be a JSON array of label keys.';
}

/** label — merge a label write into the attention wait a project-scoped run is paused at. */
async function handleLabel(ctx: ManageRunContext, input: Record<string, unknown>): Promise<string> {
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  if (runId === '') return 'manage_run: action=label requires a runId.';
  const occurrence = typeof input.occurrence === 'string' ? input.occurrence.trim() : '';
  if (occurrence === '')
    return 'manage_run: action=label requires the occurrence action=get reports.';
  const set = parseLabelParam(input, 'set', attentionLabelsSchema, {});
  if (typeof set === 'string') return set;
  const unset = parseLabelParam(input, 'unset', labelKeysSchema, []);
  if (typeof unset === 'string') return unset;
  const run = await getScopedRun(runId, ctx);
  if (typeof run === 'string') return run;
  const result = await ctx.operations.labelAttentionWait(
    run.id,
    { occurrence, set, unset },
    ctx.actor,
    'manage_run'
  );
  log.info({ runId: run.id, revision: result.revision }, 'manage_run.label_completed');
  const labels = Object.entries(result.labels).map(([key, value]) => `${key}=${value}`);
  return `Labeled run ${run.id.slice(0, 8)} at revision ${String(result.revision)}: ${
    labels.length > 0 ? labels.join(', ') : 'no labels'
  }.`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Hand a just-resolved gate to the caller's continuation and describe the
 * request for the agent. Reload after the decision: first-node legacy rework
 * has no completed node, so hydration needs the committed rejection metadata.
 * A preparation failure must not make the already-recorded decision look failed.
 *
 * A container run is never handed over: `executeWorkflow` refuses a resume it
 * cannot rewire, so scheduling one would fail the run to say what we can say
 * here for free (#2565).
 */
async function signalGateResolved(
  ctx: ManageRunContext,
  run: WorkflowRun,
  action: 'approve' | 'reject' | 'respond'
): Promise<string> {
  if (isContainerRun(run)) {
    log.info({ runId: run.id, action }, 'manage_run.gate_continuation_container_only_cli');
    return (
      ' This run executed inside an isolation container, so it cannot continue from chat — ' +
      `tell the user to finish it with \`archon workflow resume ${run.id}\` from the CLI in ` +
      'the same project.'
    );
  }
  const cmd = (command: string): string => spellWorkflowCommand(ctx.surface ?? {}, command);
  const manualResume = ` The run stays paused — it must be resumed separately (\`${cmd(`resume ${run.id}`)}\`).`;
  if (!ctx.onGateResolved) {
    log.info({ runId: run.id, action }, 'manage_run.gate_continuation_unavailable');
    return manualResume;
  }
  let continuationRun: WorkflowRun;
  try {
    continuationRun = await ctx.operations.resumeWorkflow(run.id, ctx.actor);
  } catch (error) {
    const err = toError(error);
    log.warn({ err, runId: run.id, action }, 'manage_run.gate_continuation_prepare_failed');
    return (
      ` The decision is recorded, but continuation could not be requested: ${err.message}. ` +
      `Check \`${cmd(`get ${run.id}`)}\` before retrying \`${cmd(`resume ${run.id}`)}\`.`
    );
  }
  if (!ctx.onGateResolved(continuationRun, action)) {
    log.info({ runId: run.id, action }, 'manage_run.gate_continuation_unavailable');
    return manualResume;
  }
  log.info({ runId: run.id, action }, 'manage_run.gate_continuation_scheduled');
  return ' Continuation requested — no separate resume needed.';
}

/**
 * Resolve a run id — the short prefix shown in listings OR a full id — to a run
 * in THIS chat's project. The lookup is scoped to `codebaseId` in the query, so
 * an agent in project A can never read or mutate project B's runs: a foreign id
 * simply resolves to nothing. Returns the run, or a user-facing string on miss
 * or ambiguous prefix.
 */
async function getScopedRun(runId: string, ctx: ManageRunContext): Promise<WorkflowRun | string> {
  const matches = await ctx.operations.findWorkflowRunsByIdPrefix(runId, ctx.codebaseId);
  if (matches.length > 1) {
    return `manage_run: id '${runId}' matches more than one run — use more characters or the full id.`;
  }
  const [run] = matches;
  if (run === undefined) {
    return `manage_run: no run found for id '${runId}' in this project.`;
  }
  return run;
}
