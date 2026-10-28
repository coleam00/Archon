/**
 * Routes for `archon workflow <subcommand>`: one function per subcommand, each
 * mapping parsed argv onto the workflow command module.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { isContinueSubcommand, rejectModelOnContinue } from '../dispatch-guards';
import { writeJsonLine } from '../utils/stdout';
import { type CliRouteContext, fail } from './context';
import { loadRoute, usesDatabaseStore } from './route-loader';

export type WorkflowCommands = typeof import('../commands/workflow');

/** A gated workflow invocation with its command module loaded and its host built. */
export type WorkflowRoute = CliRouteContext & { commands: WorkflowCommands; host: WorkflowHost };

/** `workflow wake|signal`, routed before the project gate. */
export async function runWorkflowContinuation(
  { positionals, values }: CliRouteContext,
  subcommand: 'wake' | 'signal'
): Promise<number> {
  // `workflow wake schedule` installs an OS timer and never opens the store or a provider.
  const wakeSchedule = subcommand === 'wake' && positionals[2] === 'schedule';
  const { workflowContinuationCommand, workflowWakeScheduleCommand } = await loadRoute(
    () => import('../commands/workflow-continuations'),
    wakeSchedule ? { providers: false } : { database: await usesDatabaseStore() }
  );
  if (wakeSchedule) return await workflowWakeScheduleCommand(positionals.slice(2), values);
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  return await workflowContinuationCommand(
    await createCliWorkflowHost(true),
    subcommand,
    positionals.slice(2),
    values
  );
}

/** `workflow test`: fixture testing reads workflow files only, so it runs before the gate. */
export async function runWorkflowTest({
  positionals,
  cwd,
  json,
}: CliRouteContext): Promise<number> {
  const target = positionals[2];
  try {
    const { workflowTestCommand } = await loadRoute(() => import('../commands/workflow'));
    return await workflowTestCommand(cwd, target, { json });
  } catch (error) {
    const err = error as Error;
    if (json) {
      await writeJsonLine({ ok: false, error: err.message });
    } else {
      console.error(`Error: ${err.message}`);
    }
    return 1;
  }
}

/**
 * The checks and loading every gated workflow subcommand shares, unknown
 * subcommands included. Returns an exit code when a check refuses.
 */
export async function prepareWorkflowRoute(ctx: CliRouteContext): Promise<WorkflowRoute | number> {
  const { subcommand, values, json } = ctx;
  const modelOnContinue = rejectModelOnContinue(subcommand, values.model);
  if (modelOnContinue) {
    return await fail(json, modelOnContinue);
  }
  if (subcommand === 'answer' && values.detach) {
    return await fail(json, 'Error: --detach cannot be used with workflow answer.');
  }
  const commands = await loadRoute(() => import('../commands/workflow'), {
    database: await usesDatabaseStore(),
  });
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  // The host's deps capture GitHub App auth when built, so commands that can
  // execute a workflow initialize it first. A misconfigured App fails here,
  // before any run row exists; query commands stay usable without it.
  const executesWorkflow = subcommand === 'run' || isContinueSubcommand(subcommand);
  const host = await createCliWorkflowHost(executesWorkflow);
  return { ...ctx, commands, host };
}

export async function runWorkflowList(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd, commands } = route;
  if (positionals[3] !== undefined) {
    return await fail(json, 'Usage: archon workflow list [name] [--full] [--json]');
  }
  try {
    await commands.workflowListCommand(effectiveCwd, {
      json,
      name: positionals[2],
      full: values.full as boolean | undefined,
    });
  } catch (error) {
    if (json && error instanceof commands.WorkflowListLookupError) {
      await writeJsonLine({
        ok: false,
        error: error.message,
        errors: error.loadErrors,
      });
      return 1;
    }
    throw error;
  }
  return 0;
}

export async function runWorkflowStatus(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  if (positionals[2] !== undefined) {
    return await fail(
      json,
      'Usage: archon workflow status [--all] [--json] [--verbose] [--events]\n' +
        'To show a single run, use: archon workflow get <run-id>'
    );
  }
  await route.commands.workflowStatusCommand(route.host, effectiveCwd, {
    json,
    verbose: values.verbose as boolean | undefined,
    rawEvents: values.events as boolean | undefined,
    all: values.all as boolean | undefined,
  });
  return 0;
}

export async function runWorkflowGet(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const getRunId = positionals[2];
  if (!getRunId || positionals[3] !== undefined) {
    return await fail(json, 'Usage: archon workflow get <run-id> [--json] [--verbose] [--events]');
  }
  // Propagate the command's exit code so `get <id> && ...` and CI
  // pipelines see a non-zero status when the run is missing.
  return await route.commands.workflowGetCommand(
    route.host,
    getRunId,
    json,
    values.verbose as boolean | undefined,
    effectiveCwd,
    values.events as boolean | undefined
  );
}

export async function runWorkflowArtifacts(route: WorkflowRoute): Promise<number> {
  const { workflowArtifactsCommand } = await import('../commands/workflow-artifacts');
  return await workflowArtifactsCommand(route.host, route.positionals.slice(2), {
    json: route.json,
    cwd: route.effectiveCwd,
  });
}

export async function runWorkflowLogs(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const logsRunId = positionals[2];
  if (!logsRunId || positionals[3] !== undefined) {
    return await fail(
      false,
      'Usage: archon workflow logs <run-id> [--follow] [--format jsonl|text]'
    );
  }
  if (json) {
    return await fail(
      false,
      'Error: workflow logs already emits JSONL; --json is not supported. Use --format text to read it as text.'
    );
  }
  const logsFormat = (values.format as string | undefined) ?? 'jsonl';
  if (logsFormat !== 'jsonl' && logsFormat !== 'text') {
    return await fail(false, `Error: --format must be 'jsonl' or 'text', got '${logsFormat}'.`);
  }
  if (values.events) {
    return await fail(false, 'Error: --events applies to workflow status/get, not workflow logs.');
  }
  return await route.commands.workflowLogsCommand(
    route.host,
    logsRunId,
    Boolean(values.follow),
    effectiveCwd,
    logsFormat
  );
}

export async function runWorkflowWait(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const waitRunId = positionals[2];
  if (!waitRunId || positionals[3] !== undefined) {
    return await fail(json, 'Usage: archon workflow wait <run-id> [--json] [--timeout <seconds>]');
  }
  const rawTimeout = values.timeout as string | undefined;
  let timeoutSeconds: number | undefined;
  if (rawTimeout !== undefined) {
    timeoutSeconds = Number(rawTimeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      return await fail(
        json,
        `Error: --timeout must be a positive number of seconds, got '${rawTimeout}'.`
      );
    }
  }
  // The wait's own exit code (3 for a deadline) has to reach the shell.
  return await route.commands.workflowWaitCommand(
    route.host,
    waitRunId,
    json,
    effectiveCwd,
    timeoutSeconds
  );
}

export async function runWorkflowRuns(route: WorkflowRoute): Promise<number> {
  const { values, json, effectiveCwd } = route;
  const rawLimit = values.limit as string | undefined;
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      return await fail(json, `Error: --limit must be a positive integer, got '${rawLimit}'.`);
    }
  }
  return await route.commands.workflowRunsCommand(route.host, effectiveCwd, {
    json,
    all: values.all as boolean | undefined,
    status: values.status as string | undefined,
    limit,
    open: values.open as boolean | undefined,
    verbose: values.verbose as boolean | undefined,
  });
}

export async function runWorkflowResume(route: WorkflowRoute): Promise<number> {
  const resumeRunId = route.positionals[2];
  if (!resumeRunId) {
    return await fail(route.json, 'Usage: archon workflow resume <run-id>');
  }
  return await route.commands.workflowResumeCommand(
    route.host,
    resumeRunId,
    route.json,
    route.effectiveCwd,
    route.values.detach as boolean | undefined
  );
}

export async function runWorkflowAbandon(route: WorkflowRoute): Promise<number> {
  const abandonRunId = route.positionals[2];
  if (!abandonRunId) {
    return await fail(route.json, 'Usage: archon workflow abandon <run-id>');
  }
  return await route.commands.workflowAbandonCommand(
    route.host,
    abandonRunId,
    route.json,
    route.effectiveCwd
  );
}

export async function runWorkflowEndTurn(route: WorkflowRoute): Promise<number> {
  const endTurnRunId = route.positionals[2];
  if (!endTurnRunId) {
    return await fail(route.json, 'Usage: archon workflow end-turn <run-id>');
  }
  const { workflowEndTurnCommand } = await import('../commands/workflow-end-turn');
  return await workflowEndTurnCommand(route.host, endTurnRunId, route.json, route.effectiveCwd);
}

export async function runWorkflowCancel(route: WorkflowRoute): Promise<number> {
  const cancelRunId = route.positionals[2];
  if (!cancelRunId) {
    return await fail(route.json, 'Usage: archon workflow cancel <run-id>');
  }
  return await route.commands.workflowCancelCommand(
    route.host,
    cancelRunId,
    route.json,
    route.effectiveCwd
  );
}

/** A gate response's free text: the flag, else the trailing positionals; empty means none. */
function responseText(flag: unknown, trailing: string[]): string | undefined {
  // Explicit empty→undefined conversion (not `|| undefined`): "no comment" must
  // reach approveWorkflow as undefined so a signal-bearing interactive-loop gate
  // finalizes instead of re-running (#2074, loop_feedback_given).
  const raw = (flag as string | undefined) || trailing.join(' ');
  return raw.length > 0 ? raw : undefined;
}

export async function runWorkflowApprove(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const approveRunId = positionals[2];
  if (!approveRunId) {
    return await fail(json, 'Usage: archon workflow approve <run-id> [comment]');
  }
  // Accept comment as positional args (everything after run ID) or --comment flag.
  return await route.commands.workflowApproveCommand(
    route.host,
    approveRunId,
    responseText(values.comment, positionals.slice(3)),
    json,
    effectiveCwd,
    values.detach as boolean | undefined,
    values.occurrence as string | undefined
  );
}

export async function runWorkflowReject(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const rejectRunId = positionals[2];
  if (!rejectRunId) {
    return await fail(json, 'Usage: archon workflow reject <run-id> [reason]');
  }
  return await route.commands.workflowRejectCommand(
    route.host,
    rejectRunId,
    responseText(values.reason, positionals.slice(3)),
    json,
    effectiveCwd,
    values.detach as boolean | undefined,
    values.occurrence as string | undefined
  );
}

export async function runWorkflowRespond(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const respondRunId = positionals[2];
  const decision = positionals[3];
  if (!respondRunId || !decision) {
    return await fail(
      json,
      'Usage: archon workflow respond <run-id> <decision> [text]\n' +
        "  'approve' and 'reject' are sugar for the equivalent dedicated commands; " +
        'any other decision must be one the gate actually declared.'
    );
  }
  return await route.commands.workflowRespondCommand(
    route.host,
    respondRunId,
    decision,
    responseText(values.text, positionals.slice(4)),
    json,
    effectiveCwd,
    values.detach as boolean | undefined,
    values.occurrence as string | undefined
  );
}

export async function runWorkflowAnswer(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const answerRunId = positionals[2];
  const answerOccurrence = values.occurrence as string | undefined;
  if (!answerRunId || answerOccurrence === undefined || positionals[3] !== undefined) {
    return await fail(
      json,
      'Usage: archon workflow answer <run-id> --occurrence <id> [--choose <id>]... [--text <text>] [--json]'
    );
  }
  return await route.commands.workflowAnswerCommand(
    route.host,
    answerRunId,
    answerOccurrence,
    (values.choose as string[] | undefined) ?? [],
    values.text as string | undefined,
    json,
    effectiveCwd
  );
}

export async function runWorkflowAttention(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  if (positionals[2] === 'label') return await runWorkflowAttentionLabel(route);
  if (positionals[3] !== undefined) {
    return await fail(
      json,
      'Usage: archon workflow attention [<run-id>] [--project <id|name|key> | --all] [--label k=v]... [--sort age|label:<key>] [--count-by project|label:<key>] [--watch [--after <cursor>]] [--json]'
    );
  }
  return await route.commands.workflowAttentionCommand(route.host, effectiveCwd, positionals[2], {
    json,
    project: values.project as string | undefined,
    all: values.all as boolean | undefined,
    labels: (values.label as string[] | undefined) ?? [],
    sort: values.sort as string | undefined,
    countBy: values['count-by'] as string | undefined,
    watch: values.watch as boolean | undefined,
    after: values.after as string | undefined,
  });
}

async function runWorkflowAttentionLabel(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const labelRunId = positionals[3];
  const labelOccurrence = values.occurrence as string | undefined;
  if (!labelRunId || labelOccurrence === undefined || positionals[4] !== undefined) {
    return await fail(
      json,
      'Usage: archon workflow attention label <run-id> --occurrence <id> [--set k=v]... [--unset k]... [--json]'
    );
  }
  return await route.commands.workflowAttentionLabelCommand(
    route.host,
    labelRunId,
    labelOccurrence,
    (values.set as string[] | undefined) ?? [],
    (values.unset as string[] | undefined) ?? [],
    json,
    effectiveCwd
  );
}

export async function runWorkflowCleanup(route: WorkflowRoute): Promise<number> {
  const daysArg = route.positionals[2];
  const days = daysArg ? Number(daysArg) : 7;
  if (Number.isNaN(days) || days < 0) {
    return await fail(
      route.json,
      'Usage: archon workflow cleanup [days]\n' +
        '  days: delete terminal runs older than N days (default: 7)'
    );
  }
  await route.commands.workflowCleanupCommand(route.host, days);
  return 0;
}

export async function runWorkflowResetSessions(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json } = route;
  const workflowName = positionals[2];
  const extras = positionals.slice(3);
  if (!workflowName) {
    return await fail(
      json,
      'Usage: archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]\n' +
        '  Without --scope: deletes persisted sessions across ALL scopes (requires --yes).'
    );
  }
  // Reject extra positionals — this is a destructive command and silently
  // dropping `archon workflow reset-sessions wf planner` (likely intent: filter to
  // node "planner") to a cross-scope wipe would be a foot-gun.
  if (extras.length > 0) {
    return await fail(
      json,
      'Usage: archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]\n' +
        `Error: unexpected positional argument(s): ${extras.join(' ')}. Use --node <id> to filter by node.`
    );
  }
  await route.commands.workflowResetSessionsCommand(route.host, workflowName, {
    scope: values.scope as string | undefined,
    node: values.node as string | undefined,
    yes: values.yes as boolean | undefined,
    json,
  });
  return 0;
}

const EVENT_EMIT_USAGE = 'Usage: archon workflow event emit --run-id <run-id> --type <event-type>';

export async function runWorkflowEvent(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd, commands } = route;
  const action = positionals[2];
  if (action !== 'emit') {
    const problem =
      action === undefined
        ? 'Missing workflow event subcommand'
        : `Unknown workflow event subcommand: ${action}`;
    return await fail(json, `${problem}\nAvailable: emit`);
  }
  const runId = values['run-id'] as string | undefined;
  const eventType = values.type as string | undefined;
  if (!runId) {
    return await fail(json, `${EVENT_EMIT_USAGE}\nError: --run-id is required`);
  }
  if (!eventType) {
    return await fail(json, `${EVENT_EMIT_USAGE}\nError: --type is required`);
  }
  if (!commands.isValidEventType(eventType)) {
    const { WORKFLOW_EVENT_TYPES } = await import('@archon/workflows/store');
    return await fail(
      json,
      `Error: unknown event type: ${eventType}\nValid types: ${WORKFLOW_EVENT_TYPES.join(', ')}`
    );
  }
  const eventData = parseEventData(values.data as string | undefined);
  await commands.workflowEventEmitCommand(route.host, runId, eventType, eventData, effectiveCwd);
  return 0;
}

function parseEventData(rawData: string | undefined): Record<string, unknown> | undefined {
  if (!rawData) return undefined;
  try {
    return JSON.parse(rawData) as Record<string, unknown>;
  } catch {
    console.warn(
      `Warning: --data is not valid JSON — event will be emitted without data payload: ${rawData}`
    );
    return undefined;
  }
}

export async function runUnknownWorkflowSubcommand({
  subcommand,
  json,
}: WorkflowRoute): Promise<number> {
  const problem =
    subcommand === undefined
      ? 'Missing workflow subcommand'
      : `Unknown workflow subcommand: ${subcommand}`;
  return await fail(
    json,
    `${problem}\nAvailable: list, run, test, status, get, artifacts, logs, wait, runs, resume, cancel, abandon, end-turn, approve, reject, respond, answer, attention, cleanup, reset-sessions, event, wake, signal`
  );
}
