import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { getArchonHome } from '@archon/paths';
import { getConversationById } from '@archon/core/db/conversations';
import { getWorkflowRun, signalWorkflowWait } from '@archon/core/db/workflows';
import { signalWorkflowWaitRequestSchema } from '@archon/core/schemas/workflow-run';
import { createCliWorkflowDeps } from '../utils/workflow-deps';
import { initializeWorkflowGitHubAppAuth } from '@archon/core/workflows/store-adapter';
import {
  resumeWorkflowContinuation,
  wakeDueWorkflowContinuations,
  type ContinuationWakeOutcome,
  type ContinuationAdmission,
} from '@archon/core/workflows/continuation-host';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { isWorkflowWaitContext } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { writeStdout } from '../utils/stdout';

import {
  installMacosNativeSchedule,
  removeMacosNativeSchedule,
  type NativeScheduleConfig,
} from '../triggers/native-schedule';

function writeJsonLine(value: unknown): Promise<void> {
  return writeStdout(`${JSON.stringify(value)}\n`);
}

type Values = Record<string, unknown>;
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function workflowWakeScheduleConfig(intervalSeconds = 5): NativeScheduleConfig {
  const archonHome = getArchonHome();
  const [executable, ...prefix] = cliProgramArguments();
  return {
    id: `workflow-wake-${createHash('sha256').update(archonHome).digest('hex')}`,
    programArguments: [executable, ...prefix, 'workflow', 'wake', '--json'],
    workingDirectory: archonHome,
    archonHome,
    schedule: { intervalSeconds, runAtLoad: true },
  };
}

async function admit(
  run: WorkflowRun,
  cursor: WorkflowResumeCursor
): Promise<ContinuationAdmission> {
  return resumeWorkflowContinuation(
    new InProcessWorkflowEngine(createCliWorkflowDeps()),
    run.id,
    async freshRun => {
      const conversation = await getConversationById(freshRun.conversation_id);
      if (!conversation)
        return { kind: 'unavailable', reason: 'origin conversation no longer exists' };
      if (conversation.platform_type !== 'cli' && conversation.platform_type !== 'api') {
        return {
          kind: 'unavailable',
          reason: `CLI cannot deliver results to '${conversation.platform_type}'; use its server host`,
        };
      }
      try {
        if (!freshRun.working_path || !(await stat(freshRun.working_path)).isDirectory()) {
          return { kind: 'unavailable', reason: 'recorded working path is not a directory' };
        }
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: `recorded working path is unavailable: ${errorMessage(error)}`,
        };
      }
      return {
        kind: 'ready',
        platform: new HeadlessPlatform(freshRun.conversation_id, CLI_WORKFLOW_SURFACE),
        conversationId: freshRun.conversation_id,
      };
    },
    cursor
  );
}

type SettledOutcome = { runId: string; deferError?: string } & (
  | { kind: 'accepted'; status: 'paused' | 'completed' | 'failed'; error?: string }
  | Exclude<ContinuationAdmission, { kind: 'accepted' }>
  | { kind: 'failed'; error: string }
);

async function settle(outcome: ContinuationWakeOutcome): Promise<SettledOutcome> {
  const { runId, deferError } = outcome;
  const deferral = deferError === undefined ? {} : { deferError: errorMessage(deferError) };
  if (outcome.kind === 'accepted') {
    try {
      const result = await outcome.settled;
      if ('paused' in result) return { runId, kind: outcome.kind, status: 'paused', ...deferral };
      return result.success
        ? { runId, kind: outcome.kind, status: 'completed', ...deferral }
        : { runId, kind: outcome.kind, status: 'failed', error: result.error, ...deferral };
    } catch (error) {
      return {
        runId,
        kind: outcome.kind,
        status: 'failed',
        error: errorMessage(error),
        ...deferral,
      };
    }
  }
  if (outcome.kind === 'unavailable')
    return { runId, kind: outcome.kind, reason: outcome.reason, ...deferral };
  if (outcome.kind === 'failed')
    return { runId, kind: outcome.kind, error: errorMessage(outcome.error), ...deferral };
  return { runId, kind: outcome.kind, ...deferral };
}

function successful(outcome: SettledOutcome): boolean {
  return (
    outcome.deferError === undefined &&
    (outcome.kind === 'not-accepted' ||
      (outcome.kind === 'accepted' && outcome.status !== 'failed'))
  );
}

async function report(
  action: string,
  outcomes: SettledOutcome[],
  json: boolean,
  signaled?: boolean
): Promise<boolean> {
  const ok = outcomes.every(successful);
  const accepted = outcomes.filter(outcome => outcome.kind === 'accepted').length;
  if (json)
    await writeJsonLine({
      ok,
      action,
      accepted,
      ...(signaled === undefined ? {} : { signaled }),
      ...(signaled && !ok
        ? {
            hint: 'Signal retained. Retry archon workflow wake after resolving the refusal or failure.',
          }
        : {}),
      outcomes,
    });
  else {
    console.log(
      `${action}: ${String(accepted)} continuation(s) accepted${ok ? '' : '; errors reported'}`
    );
    for (const outcome of outcomes) {
      console.log(
        `${outcome.runId}: ${outcome.kind}${'status' in outcome ? ` (${outcome.status})` : ''}${'reason' in outcome ? `: ${outcome.reason}` : ''}${'error' in outcome ? `: ${outcome.error}` : ''}${outcome.deferError ? `; deferral failed: ${outcome.deferError}` : ''}`
      );
    }
    if (signaled && !ok)
      console.error(
        'Signal retained. Retry archon workflow wake after resolving the refusal or failure.'
      );
  }
  return ok;
}

function validateFlags(values: Values, allowed: string[]): void {
  const allowedKeys = new Set(['cwd', 'help', 'json', ...allowed]);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowedKeys.has(key))
      throw new Error(`--${key} is not supported by this command`);
  }
}

export async function workflowContinuationCommand(
  action: 'wake' | 'signal',
  args: string[],
  values: Values
): Promise<number> {
  const json = values.json === true;
  try {
    if (action === 'wake' && args[0] === 'schedule') return await wakeSchedule(args, values, json);
    initializeWorkflowGitHubAppAuth();
    if (action === 'signal') return await signalEvent(args, values, json);
    return await wake(args, values, json);
  } catch (error) {
    if (json)
      await writeJsonLine({ ok: false, action, signaled: false, error: errorMessage(error) });
    else console.error(errorMessage(error));
    return 1;
  }
}

async function wakeSchedule(args: string[], values: Values, json: boolean): Promise<number> {
  const operation = args[1];
  if (args.length !== 2 || (operation !== 'install' && operation !== 'remove')) {
    throw new Error(
      'Usage: archon workflow wake schedule <install|remove> [--interval <seconds>] [--json]'
    );
  }
  validateFlags(values, operation === 'install' ? ['interval'] : []);
  const interval = values.interval === undefined ? 5 : Number(values.interval);
  if (!Number.isSafeInteger(interval) || interval <= 0)
    throw new Error('--interval must be a positive integer in seconds');
  const config = workflowWakeScheduleConfig(interval);
  const result =
    operation === 'install'
      ? { path: await installMacosNativeSchedule(config) }
      : { removed: await removeMacosNativeSchedule(config.id) };
  if (json) await writeJsonLine({ ok: true, action: `wake schedule ${operation}`, ...result });
  else console.log(`wake schedule ${operation}: ${JSON.stringify(result)}`);
  return 0;
}

async function signalEvent(args: string[], values: Values, json: boolean): Promise<number> {
  validateFlags(values, ['event', 'resume-at', 'data']);
  const runId = args[0];
  if (
    !runId ||
    args.length !== 1 ||
    values.event === undefined ||
    values['resume-at'] === undefined
  ) {
    throw new Error(
      'Usage: archon workflow signal <full-run-id> --event <name> --resume-at <ISO timestamp> [--data <JSON>] [--json]'
    );
  }
  let data: unknown;
  if (typeof values.data === 'string') {
    try {
      data = JSON.parse(values.data);
    } catch {
      throw new Error('--data must be valid JSON');
    }
  }
  const { event, resumeAt, payload } = signalWorkflowWaitRequestSchema.parse({
    event: values.event,
    resumeAt: values['resume-at'],
    payload: data,
  });
  const run = await getWorkflowRun(runId);
  const wait = run && isWorkflowWaitContext(run.metadata.wait) ? run.metadata.wait : undefined;
  if (!run || wait?.kind !== 'event' || wait.event !== event || wait.resumeAt !== resumeAt) {
    throw new Error(
      'Run is not waiting on that event occurrence; use its full run id and current resumeAt'
    );
  }
  const { signaled } = await signalWorkflowWait(runId, wait, payload);
  if (!signaled)
    throw new Error('Event occurrence is stale, expired, already signaled, or no longer paused');
  let outcome: ContinuationWakeOutcome;
  try {
    outcome = { runId, ...(await admit(run, { kind: 'wait', nodeId: wait.nodeId, resumeAt })) };
  } catch (error) {
    outcome = { runId, kind: 'failed', error };
  }
  return (await report('signal', [await settle(outcome)], json, true)) ? 0 : 1;
}

async function wake(args: string[], values: Values, json: boolean): Promise<number> {
  validateFlags(values, ['watch']);
  if (args.length) throw new Error('Usage: archon workflow wake [--watch] [--json]');
  let stopped = false;
  let wakeSleep: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    wakeSleep?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let ok = true;
  try {
    do {
      try {
        const outcomes = await wakeDueWorkflowContinuations(new Date(), admit);
        const passOk = await report('wake', await Promise.all(outcomes.map(settle)), json);
        ok = passOk && ok;
      } catch (error) {
        ok = false;
        if (json) await writeJsonLine({ ok: false, action: 'wake', error: errorMessage(error) });
        else console.error(`wake: ${errorMessage(error)}`);
      }
      if (!values.watch || stopped) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5_000);
        wakeSleep = (): void => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeSleep = undefined;
    } while (!stopped);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return ok ? 0 : 1;
}
