/**
 * Routes for `archon workflow <subcommand>`: one function per subcommand, each
 * mapping parsed argv onto the workflow command module.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { isContinueSubcommand, rejectRunFlagsOnContinue } from '../dispatch-guards';
import type { ItemTarget } from '../commands/item-target';
import type { WorkflowLinkRequest } from '../commands/workflow-link';
import { writeJsonLine } from '../utils/stdout';
import { type CliRouteContext, fail } from './context';
import { loadRoute, usesDatabaseStore } from './route-loader';

export type WorkflowCommands = typeof import('../commands/workflow');

/** A gated workflow invocation with its command module loaded and its host built. */
export type WorkflowRoute = CliRouteContext & { commands: WorkflowCommands; host: WorkflowHost };

/** `workflow wake|signal`, routed before the project gate. */
export async function runWorkflowContinuation(
  { positionals, values, forgeTrustedEnv }: CliRouteContext,
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
  const host = await createCliWorkflowHost({ forgeTrustedEnv });
  // Loaded only when wake asks for it, so `signal` never loads the source plugins.
  return await workflowContinuationCommand(
    host,
    subcommand,
    positionals.slice(2),
    values,
    async () =>
      (await import('../commands/wake-observation')).wakeObservation(host, forgeTrustedEnv)
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

/** `workflow types`: generation reads workflow files only, so it runs before the gate. */
export async function runWorkflowTypes({
  positionals,
  values,
  cwd,
  json,
}: CliRouteContext): Promise<number> {
  const target = positionals[2];
  if (target === undefined || positionals[3] !== undefined) {
    return await fail(
      json,
      'Usage: archon workflow types <name|folder|path> [--out <file>] [--check] [--json]'
    );
  }
  try {
    const { workflowTypesCommand } = await loadRoute(() => import('../commands/workflow-types'));
    return await workflowTypesCommand(cwd, target, {
      json,
      check: values.check as boolean | undefined,
      out: values.out as string | undefined,
    });
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
  const runFlagOnContinue = rejectRunFlagsOnContinue(subcommand, values);
  if (runFlagOnContinue) {
    return await fail(json, runFlagOnContinue);
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
  const host = await createCliWorkflowHost(
    executesWorkflow ? { forgeTrustedEnv: ctx.forgeTrustedEnv } : undefined
  );
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
    return await fail(
      json,
      'Usage: archon workflow get <run-id> [--json] [--verbose] [--events] [--throughput]'
    );
  }
  // Propagate the command's exit code so `get <id> && ...` and CI
  // pipelines see a non-zero status when the run is missing.
  return await route.commands.workflowGetCommand(
    route.host,
    getRunId,
    json,
    values.verbose as boolean | undefined,
    effectiveCwd,
    values.events as boolean | undefined,
    values.throughput as boolean | undefined
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

/**
 * The target of `wait`, `cancel` or `abandon`: one run id, or `--item <key>`. A usage
 * error is returned as its message.
 */
function runOrItemTarget(
  { positionals, values }: WorkflowRoute,
  verb: 'wait' | 'cancel' | 'abandon'
): { runId: string } | { item: string; allRuns: boolean } | { usage: string } {
  const runId = positionals[2];
  const item = values.item as string | undefined;
  const allRuns = values['all-runs'] === true;
  const usage =
    verb === 'wait'
      ? 'Usage: archon workflow wait <run-id> | --item <key> [--json] [--timeout <seconds>]'
      : `Usage: archon workflow ${verb} <run-id> | --item <key> [--all-runs]`;
  if (verb === 'wait' && positionals[3] !== undefined) return { usage };
  if (runId !== undefined && item !== undefined)
    return { usage: `Error: Pass a run id or --item <key>, not both.\n${usage}` };
  if (allRuns && verb === 'wait')
    return { usage: 'Error: --all-runs applies to cancel and abandon.' };
  if (allRuns && item === undefined)
    return { usage: `Error: --all-runs applies with --item.\n${usage}` };
  if (item !== undefined) return { item, allRuns };
  return runId === undefined ? { usage } : { runId };
}

export async function runWorkflowWait(route: WorkflowRoute): Promise<number> {
  const { values, json, effectiveCwd } = route;
  const target = runOrItemTarget(route, 'wait');
  if ('usage' in target) return await fail(json, target.usage);
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
  if ('item' in target)
    return await route.commands.workflowWaitItemCommand(route.host, target.item, effectiveCwd, {
      json,
      timeoutSeconds,
    });
  return await route.commands.workflowWaitCommand(
    route.host,
    target.runId,
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
    item: values.item as string | undefined,
    itemOf: values['item-of'] as string | undefined,
    verbose: values.verbose as boolean | undefined,
    throughput: values.throughput as boolean | undefined,
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

export async function runWorkflowPause(route: WorkflowRoute): Promise<number> {
  const pauseRunId = route.positionals[2];
  if (!pauseRunId) {
    return await fail(route.json, 'Usage: archon workflow pause <run-id> [--as <name>]');
  }
  return await route.commands.workflowPauseCommand(route.host, pauseRunId, {
    json: route.json,
    cwd: route.effectiveCwd,
    as: route.values.as as string | undefined,
  });
}

export async function runWorkflowAbandon(route: WorkflowRoute): Promise<number> {
  const target = runOrItemTarget(route, 'abandon');
  if ('usage' in target) return await fail(route.json, target.usage);
  if ('item' in target)
    return await route.commands.workflowAbandonItemCommand(
      route.host,
      target.item,
      route.effectiveCwd,
      { json: route.json, allRuns: target.allRuns }
    );
  return await route.commands.workflowAbandonCommand(
    route.host,
    target.runId,
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
  const target = runOrItemTarget(route, 'cancel');
  if ('usage' in target) return await fail(route.json, target.usage);
  if ('item' in target)
    return await route.commands.workflowCancelItemCommand(
      route.host,
      target.item,
      route.effectiveCwd,
      { json: route.json, allRuns: target.allRuns }
    );
  return await route.commands.workflowCancelCommand(
    route.host,
    target.runId,
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
    values.occurrence as string | undefined,
    values.as as string | undefined
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
    values.occurrence as string | undefined,
    values.as as string | undefined
  );
}

export async function runWorkflowRespond(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const respondRunId = positionals[2];
  // `--recommended` stands in for the decision. It accepts a recommendation the answerer
  // read, so it must name the occurrence it read it on: without one it would accept the
  // recommendation of whichever wait the run has moved to since.
  if (values.recommended === true) {
    const occurrence = values.occurrence as string | undefined;
    if (!respondRunId || occurrence === undefined || positionals[3] !== undefined)
      return await fail(
        json,
        'Usage: archon workflow respond <run-id> --recommended --occurrence <id> [--text <text>] [--as <name>] [--json]\n' +
          '  --recommended takes the place of <decision>, so it takes no positional decision or text.'
      );
    if (values.detach === true)
      return await fail(json, 'workflow respond --recommended takes no --detach');
    return await route.commands.workflowAnswerCommand(
      route.host,
      respondRunId,
      occurrence,
      { recommended: true },
      values.text as string | undefined,
      json,
      effectiveCwd,
      values.as as string | undefined
    );
  }
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
    values.occurrence as string | undefined,
    values.as as string | undefined
  );
}

export async function runWorkflowAnswer(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  const ref = values.ref as string | undefined;
  const withdraw = values.withdraw as string | undefined;
  if (ref !== undefined || withdraw !== undefined) return await runWorkflowAnswerByRef(route);
  const answerRunId = positionals[2];
  const answerOccurrence = values.occurrence as string | undefined;
  const choose = (values.choose as string[] | undefined) ?? [];
  const recommended = values.recommended === true;
  if (
    !answerRunId ||
    answerOccurrence === undefined ||
    positionals[3] !== undefined ||
    (recommended && choose.length > 0)
  ) {
    return await fail(
      json,
      'Usage: archon workflow answer <run-id> --occurrence <id> [--choose <id>... | --recommended] [--text <text>] [--as <name>] [--json]'
    );
  }
  return await route.commands.workflowAnswerCommand(
    route.host,
    answerRunId,
    answerOccurrence,
    recommended ? { recommended: true } : { choose },
    values.text as string | undefined,
    json,
    effectiveCwd,
    values.as as string | undefined
  );
}

/** `workflow answer --ref <ref>` or `--withdraw <ref>`: an item named by its queue ref. */
async function runWorkflowAnswerByRef(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands } = route;
  const ref = values.ref as string | undefined;
  const withdraw = values.withdraw as string | undefined;
  const choose = (values.choose as string[] | undefined) ?? [];
  const recommended = values.recommended === true;
  const text = values.text as string | undefined;
  const as = values.as as string | undefined;
  const extra = positionals[2] !== undefined || values.occurrence !== undefined;
  const request =
    withdraw !== undefined && ref === undefined && choose.length === 0 && !recommended && !extra
      ? text === undefined
        ? { withdraw, as }
        : undefined
      : ref !== undefined && withdraw === undefined && !extra && !(recommended && choose.length > 0)
        ? { ref, selection: recommended ? { recommended: true as const } : { choose }, text, as }
        : undefined;
  if (request === undefined) return await fail(json, commands.WORKFLOW_ANSWER_REF_USAGE);
  return await commands.workflowAnswerRefCommand(route.host, request, json);
}

export async function runWorkflowAttention(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, effectiveCwd } = route;
  if (positionals[2] === 'label') return await runWorkflowAttentionLabel(route);
  if (positionals[3] !== undefined) {
    return await fail(
      json,
      'Usage: archon workflow attention [<run-id>|ask:<id>] [--project <id|name|key> | --all] [--label k=v]... [--sort age|label:<key>] [--count-by project|label:<key>|answerer [--since <40m|24h|7d|2w|ISO>]] [--notices --since <40m|24h|7d|2w|ISO>] [--watch [--notices | --protocol [--after <cursor>]]] [--json]'
    );
  }
  return await route.commands.workflowAttentionCommand(route.host, effectiveCwd, positionals[2], {
    json,
    project: values.project as string | undefined,
    all: values.all as boolean | undefined,
    labels: (values.label as string[] | undefined) ?? [],
    sort: values.sort as string | undefined,
    countBy: values['count-by'] as string | undefined,
    since: values.since as string | undefined,
    watch: values.watch as boolean | undefined,
    protocol: values.protocol as boolean | undefined,
    notices: values.notices as boolean | undefined,
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
  if (route.values.orphans)
    return daysArg === undefined
      ? await route.commands.workflowOrphanCleanupCommand(route.host, { yes: !!route.values.yes })
      : await fail(route.json, 'Usage: archon workflow cleanup --orphans [--yes]');
  const days = daysArg ? Number(daysArg) : 7;
  if (Number.isNaN(days) || days < 0) {
    return await fail(
      route.json,
      'Usage: archon workflow cleanup [days] | archon workflow cleanup --orphans [--yes]\n' +
        '  days: delete terminal runs older than N days, with their files (default: 7)'
    );
  }
  return await route.commands.workflowCleanupCommand(route.host, days);
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

export async function runWorkflowNotice(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands } = route;
  const text = positionals[2];
  if (text === undefined || positionals[3] !== undefined)
    return await fail(json, commands.WORKFLOW_NOTICE_USAGE);
  return await commands.workflowNoticeCommand(
    route.host,
    text,
    (values.label as string[] | undefined) ?? [],
    json
  );
}

export async function runWorkflowRule(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands, effectiveCwd } = route;
  const item = values.item as string | undefined;
  const withdraw = values.withdraw as string | undefined;
  const as = values.as as string | undefined;
  const text = positionals[2];
  // Exactly one of the two forms: a ruling's text after --, or the id of one to withdraw.
  const request =
    withdraw !== undefined && item === undefined && text === undefined
      ? { withdraw, as }
      : withdraw === undefined && item !== undefined && text?.trim() && positionals[3] === undefined
        ? { item, text, as }
        : undefined;
  if (request === undefined) return await fail(json, commands.WORKFLOW_RULE_USAGE);
  return await commands.workflowRuleCommand(route.host, effectiveCwd, request, json);
}

export async function runWorkflowEnd(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands, effectiveCwd } = route;
  const item = values.item as string | undefined;
  const as = values.as as string | undefined;
  const reason = positionals[2];
  if (item === undefined || !reason?.trim() || positionals[3] !== undefined)
    return await fail(json, commands.WORKFLOW_END_USAGE);
  const request = { item, reason, as };
  return await commands.workflowEndCommand(
    route.host,
    effectiveCwd,
    request,
    json,
    route.inheritedEnv
  );
}

export async function runWorkflowItems(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands, effectiveCwd } = route;
  if (positionals[2] !== undefined) return await fail(json, commands.WORKFLOW_ITEMS_USAGE);
  const rawLimit = values.limit as string | undefined;
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  const since = values.since as string | undefined;
  const until = values.until as string | undefined;
  const after = values.after as string | undefined;
  return await commands.workflowItemsCommand(
    route.host,
    effectiveCwd,
    {
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    },
    json
  );
}

export async function runWorkflowMerged(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands, effectiveCwd } = route;
  const target = itemTarget(values);
  const change = values.change as string | undefined;
  const at = values.at as string | undefined;
  const commit = values.commit as string | undefined;
  if (
    target === undefined ||
    change === undefined ||
    at === undefined ||
    positionals[2] !== undefined
  )
    return await fail(json, commands.WORKFLOW_MERGED_USAGE);
  return await commands.workflowMergedCommand(
    route.host,
    effectiveCwd,
    { ...target, change, at, ...(commit === undefined ? {} : { commit }) },
    json
  );
}

/** Exactly one of `--item <key>` and `--item-of <run-id>`, or undefined. */
function itemTarget(values: WorkflowRoute['values']): ItemTarget | undefined {
  const item = values.item as string | undefined;
  const itemOf = values['item-of'] as string | undefined;
  if (item !== undefined && itemOf === undefined) return { item };
  if (itemOf !== undefined && item === undefined) return { itemOf };
  return undefined;
}

export async function runWorkflowLanding(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands, effectiveCwd } = route;
  const target = itemTarget(values);
  const branch = values.branch as string | undefined;
  const from = (values.from ?? values['from-branch']) as string | undefined;
  if (target === undefined || branch === undefined || positionals[2] !== undefined)
    return await fail(json, commands.WORKFLOW_LANDING_USAGE);
  return await commands.workflowLandingCommand(
    route.host,
    effectiveCwd,
    { ...target, branch, ...(from === undefined ? {} : { from }) },
    json
  );
}

export async function runWorkflowTitle(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands, effectiveCwd } = route;
  const target = itemTarget(values);
  const text = values.text as string | undefined;
  if (target === undefined || text === undefined || positionals[2] !== undefined)
    return await fail(json, commands.WORKFLOW_TITLE_USAGE);
  return await commands.workflowTitleCommand(route.host, effectiveCwd, { ...target, text }, json);
}

/**
 * Exactly one form, or undefined: a link from `--item` to `--to`, a link from or to the
 * `--item-of` run's item (`--to` or `--from`), or the id of a link to end.
 */
function linkRequest(values: WorkflowRoute['values']): WorkflowLinkRequest | undefined {
  const text = (name: string) => values[name] as string | undefined;
  const [item, itemOf, kind, to, from] = [
    text('item'),
    text('item-of'),
    text('kind'),
    text('to'),
    text('from'),
  ];
  const [end, as] = [text('end'), text('as')];
  const named = [item, itemOf, kind, to, from].filter(value => value !== undefined).length;
  if (end !== undefined) return named === 0 ? { end, as } : undefined;
  if (named !== 3 || kind === undefined) return undefined;
  if (item !== undefined && to !== undefined) return { item, kind, to, as };
  if (itemOf !== undefined && to !== undefined) return { itemOf, kind, to, as };
  if (itemOf !== undefined && from !== undefined) return { itemOf, kind, from, as };
  return undefined;
}

export async function runWorkflowLink(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json, commands, effectiveCwd } = route;
  const request = positionals[2] === undefined ? linkRequest(values) : undefined;
  if (request === undefined) return await fail(json, commands.WORKFLOW_LINK_USAGE);
  return await commands.workflowLinkCommand(route.host, effectiveCwd, request, json);
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
    `${problem}\nAvailable: list, run, test, types, status, get, artifacts, logs, wait, runs, pause, resume, cancel, abandon, end-turn, approve, reject, respond, answer, attention, rule, end, link, items, merged, landing, title, cleanup, reset-sessions, event, notice, wake, signal`
  );
}
