import type { WorkflowResumeOptions } from '@archon/workflows/engine-port';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { toPersistedMessageMetadata } from '@archon/core/types';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { getArchonHome } from '@archon/paths';
import { signalWorkflowWaitRequestSchema } from '@archon/core/schemas/workflow-run';
import { resumeWorkflowContinuation } from '@archon/core/workflows/continuation-host';
import {
  wakeDueWorkflowContinuations,
  type ContinuationWakeOutcome,
  type ContinuationAdmission,
} from '@archon/core/workflows/continuation-resume';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import { drainResourceStartHost } from '@archon/core/workflows/resource-start-host';
import type { ItemWaitObserver, ObservedSourceReport } from '@archon/core/workflows/source-plugins';
import type { StartedExecutor } from '@archon/core/workflows/start-executor';
import { isWorkflowWaitContext } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { deadlineWaitCursor, type WorkflowResumeCursor } from '@archon/workflows/store';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { engineFingerprint } from '../utils/engine-fingerprint';
import { parseIntervalSeconds, validateFlags } from '../utils/command-flags';
import { writeStdout } from '../utils/stdout';

import {
  installNativeSchedule,
  removeNativeSchedule,
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
    programArguments: [executable, ...prefix, 'workflow', 'wake', '--watch', '--json'],
    workingDirectory: archonHome,
    archonHome,
    path: process.env.PATH ?? '',
    schedule: { intervalSeconds, runAtLoad: true },
    // A watcher writes a line every pass, forever; a log of it would only grow.
    output: 'discard',
    removeCommand: 'archon workflow wake schedule remove',
  };
}

async function admit(
  host: WorkflowHost,
  run: WorkflowRun,
  cursor: WorkflowResumeCursor,
  deferScratchCleanup?: WorkflowResumeOptions['deferScratchCleanup']
): Promise<ContinuationAdmission> {
  return resumeWorkflowContinuation(
    host,
    run.id,
    async freshRun => {
      const historyConversationId = freshRun.conversation_id ?? freshRun.parent_conversation_id;
      const conversation = historyConversationId
        ? await host.records.conversations.getConversationById(historyConversationId)
        : null;
      if (historyConversationId && !conversation)
        return { kind: 'unavailable', reason: 'origin conversation no longer exists' };
      if (
        conversation &&
        conversation.platform_type !== 'cli' &&
        conversation.platform_type !== 'api'
      ) {
        return {
          kind: 'unavailable',
          reason: `CLI cannot deliver results to '${conversation.platform_type}'; use its server host`,
        };
      }
      let workingPathError: string | undefined;
      try {
        if (!freshRun.working_path || !(await stat(freshRun.working_path)).isDirectory()) {
          workingPathError = 'recorded working path is not a directory';
        }
      } catch (error) {
        workingPathError = `recorded working path is unavailable: ${errorMessage(error)}`;
      }
      if (workingPathError) {
        return { kind: 'unavailable', reason: workingPathError };
      }
      return {
        kind: 'ready',
        platform: new HeadlessPlatform(
          historyConversationId
            ? async (message, metadata): Promise<void> => {
                await host.records.messages.addMessage(
                  historyConversationId,
                  'assistant',
                  message,
                  toPersistedMessageMetadata(metadata)
                );
              }
            : undefined,
          CLI_WORKFLOW_SURFACE
        ),
        conversationId: freshRun.conversation_id ?? freshRun.id,
      };
    },
    cursor,
    undefined,
    { deferScratchCleanup }
  );
}

type SettledOutcome = { runId: string; deferError?: string } & (
  | { kind: 'accepted'; status: 'paused' | 'completed' | 'failed'; error?: string }
  | {
      kind: 'accepted';
      status: 'handed_off';
      observedStatus: Exclude<WorkflowRunStatus, 'failed' | 'cancelled'> | null;
    }
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
      if ('handedOff' in result && result.success) {
        const { observedStatus } = result;
        return { runId, kind: outcome.kind, status: 'handed_off', observedStatus, ...deferral };
      }
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
  if (outcome.kind === 'waiting_for_capacity' || outcome.kind === 'resource_busy') {
    const { deferError: _deferError, ...refusal } = outcome;
    return { ...refusal, ...deferral };
  }
  return { runId, kind: outcome.kind, ...deferral };
}

function successful(outcome: SettledOutcome): boolean {
  return (
    outcome.deferError === undefined &&
    (outcome.kind === 'not-accepted' ||
      outcome.kind === 'waiting_for_capacity' ||
      outcome.kind === 'resource_busy' ||
      (outcome.kind === 'accepted' && outcome.status !== 'failed'))
  );
}

function describeOutcome(outcome: SettledOutcome): string {
  const observed =
    'observedStatus' in outcome ? `, observed ${outcome.observedStatus ?? 'run removed'}` : '';
  return `${outcome.runId}: ${outcome.kind}${'status' in outcome ? ` (${outcome.status}${observed})` : ''}${'reason' in outcome ? `: ${outcome.reason}` : ''}${'blocker' in outcome ? `: blocked by ${outcome.blocker.kind} ${outcome.blocker.id}` : ''}${'error' in outcome ? `: ${outcome.error}` : ''}${outcome.deferError ? `; deferral failed: ${outcome.deferError}` : ''}`;
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
    for (const outcome of outcomes) console.log(describeOutcome(outcome));
    if (signaled && !ok)
      console.error(
        'Signal retained. Retry archon workflow wake after resolving the refusal or failure.'
      );
  }
  return ok;
}

/**
 * Observes open item waits for an install that receives no webhooks (the sources in
 * `ARCHON_WEBHOOK_SOURCES` that declare `observe`), and hands each start it admits to its
 * executor.
 */
export interface WakeObservation {
  observer: ItemWaitObserver;
  dispatch: (requestId: string, hostId: string) => Promise<StartedExecutor | null>;
}

export async function workflowContinuationCommand(
  host: WorkflowHost,
  action: 'wake' | 'signal',
  args: string[],
  values: Values,
  observation?: () => Promise<WakeObservation | undefined>
): Promise<number> {
  const json = values.json === true;
  try {
    if (action === 'signal') return await signalEvent(host, args, values, json);
    return await wake(host, args, values, json, await observation?.());
  } catch (error) {
    if (json)
      await writeJsonLine({ ok: false, action, signaled: false, error: errorMessage(error) });
    else console.error(errorMessage(error));
    return 1;
  }
}

export async function workflowWakeScheduleCommand(args: string[], values: Values): Promise<number> {
  const json = values.json === true;
  try {
    return await wakeSchedule(args, values, json);
  } catch (error) {
    if (json)
      await writeJsonLine({
        ok: false,
        action: 'wake',
        signaled: false,
        error: errorMessage(error),
      });
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
  // A long-lived watcher is not the one-shot job the systemd and Task Scheduler backends run.
  if (process.platform !== 'darwin')
    throw new Error(
      'Native wake scheduling is supported only on macOS. Use the documented long-lived systemd or Task Scheduler recipe on this host.'
    );
  const config = workflowWakeScheduleConfig(parseIntervalSeconds(values, 5));
  const result =
    operation === 'install'
      ? { path: (await installNativeSchedule(config)).path }
      : { removed: await removeNativeSchedule(config) };
  if (json) await writeJsonLine({ ok: true, action: `wake schedule ${operation}`, ...result });
  else console.log(`wake schedule ${operation}: ${JSON.stringify(result)}`);
  return 0;
}

async function signalEvent(
  host: WorkflowHost,
  args: string[],
  values: Values,
  json: boolean
): Promise<number> {
  validateFlags(values, ['event', 'occurrence', 'resume-at', 'data']);
  const runId = args[0];
  if (
    !runId ||
    args.length !== 1 ||
    values.event === undefined ||
    (values.occurrence === undefined && values['resume-at'] === undefined)
  ) {
    throw new Error(
      'Usage: archon workflow signal <full-run-id> --event <name> (--occurrence <id> | --resume-at <ISO timestamp>) [--data <JSON>] [--json]'
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
  const request = signalWorkflowWaitRequestSchema.parse({
    occurrence: values.occurrence,
    event: values.event,
    resumeAt: values['resume-at'],
    payload: data,
  });
  const { event, occurrence, resumeAt } = request;
  const run = await host.deps.store.getWorkflowRun(runId);
  const wait = run && isWorkflowWaitContext(run.metadata.wait) ? run.metadata.wait : undefined;
  if (
    !run ||
    wait?.kind !== 'event' ||
    wait.event !== event ||
    (occurrence !== undefined && wait.pauseId !== occurrence) ||
    (resumeAt !== undefined && wait.resumeAt !== resumeAt)
  ) {
    throw new Error(
      'Run is not waiting on that event occurrence; use its full run id and current pauseId (or resumeAt for legacy waits)'
    );
  }
  const { signaled } = await host.operations.signalWorkflowWait(runId, request, {
    kind: 'operator',
  });
  if (!signaled)
    throw new Error('Event occurrence is stale, expired, already signaled, or no longer paused');
  let outcome: ContinuationWakeOutcome;
  try {
    outcome = {
      runId,
      ...(await admit(host, run, deadlineWaitCursor(wait))),
    };
  } catch (error) {
    outcome = { runId, kind: 'failed', error };
  }
  return (await report('signal', [await settle(outcome)], json, true)) ? 0 : 1;
}

/**
 * `wake --watch` exits with this when the installed engine changed under it,
 * so its supervisor restarts it on current code (EX_TEMPFAIL). Nonzero on
 * purpose: systemd `Restart=on-failure` and Task Scheduler's restart act only
 * on a failure, and launchd's StartInterval restarts any exit.
 */
const WAKE_ENGINE_CHANGED_EXIT = 75;

/**
 * A resident watcher runs every resume, and each run's terminal trigger read,
 * on the engine it loaded; record which one so it can stop once the install
 * moves on. An unreadable engine turns the check off, and says so.
 */
async function loadedEngine(watch: boolean, json: boolean): Promise<string | undefined> {
  if (!watch) return undefined;
  const loaded = engineFingerprint();
  if (loaded !== undefined) return loaded;
  if (json) await writeJsonLine({ ok: true, action: 'wake', engine: 'unknown' });
  else console.error('wake: engine unknown; restart the watcher after updating Archon');
  return undefined;
}

async function engineChanged(loaded: string | undefined, json: boolean): Promise<boolean> {
  if (loaded === undefined) return false;
  const current = engineFingerprint();
  if (current === loaded) return false;
  if (json) {
    await writeJsonLine({
      ok: true,
      action: 'wake',
      restart: 'engine changed',
      loaded,
      current: current ?? null,
    });
  } else console.log(`wake: engine changed (${loaded} -> ${current}), exiting to restart`);
  return true;
}

/**
 * One source's observation, as `wake` reports it. The hosts of the starts it recorded are
 * added to `owed`, which `drainOwed` empties.
 */
/** How many starts `receipts` recorded; adds each start's host to `owed`. */
async function owedStarts(
  host: WorkflowHost,
  receipts: readonly string[],
  owed: Set<string>
): Promise<number> {
  let started = 0;
  for (const receiptId of receipts)
    for (const binding of (await host.deps.store.getStartReceipt(receiptId))?.bindings ?? []) {
      // A binding recorded as unmatched or rejected has no host and starts nothing.
      if (!binding.hostId) continue;
      started += 1;
      owed.add(binding.hostId);
    }
  return started;
}

/** Says which sources a watch observes and how often, once when it starts. */
async function announceObserving(
  observation: WakeObservation | undefined,
  watch: boolean,
  json: boolean
): Promise<void> {
  if (!watch || !observation) return;
  const observe = observation.observer.observing.map(({ sourceInstanceId, everySeconds }) => ({
    source: sourceInstanceId,
    everySeconds,
  }));
  if (json) await writeJsonLine({ ok: true, action: 'wake', observe });
  else
    for (const { source, everySeconds } of observe)
      console.log(`wake: observing source ${source} every ${String(everySeconds)}s`);
}

/** One observation pass: report each source, then hand on the starts it owes. */
async function observePass(
  host: WorkflowHost,
  observation: WakeObservation | undefined,
  owed: Set<string>,
  json: boolean
): Promise<boolean> {
  if (!observation) return true;
  let ok = true;
  for (const observed of await observation.observer.pass(new Date()))
    ok = (await reportObserved(host, observed, owed, json)) && ok;
  return (await drainOwed(host, observation, owed, json)) && ok;
}

async function reportObserved(
  host: WorkflowHost,
  report: ObservedSourceReport,
  owed: Set<string>,
  json: boolean
): Promise<boolean> {
  const started = await owedStarts(host, report.receipts, owed);
  const { source, waits, reads, conflicts, unserved, error } = report;
  const ok = error === undefined;
  if (json)
    await writeJsonLine({
      ok,
      action: 'observe',
      source,
      waits,
      reads,
      started,
      conflicts,
      unserved,
      ...(ok ? {} : { error }),
    });
  else {
    console.log(
      `observe ${source}: ${String(waits)} wait(s), ${String(reads)} read(s), ${String(started)} start(s)${conflicts ? `, ${String(conflicts)} conflicting deliveries` : ''}${ok ? '' : `; ${error}`}`
    );
    for (const { wait, reason } of unserved)
      console.log(
        `  not observed: ${wait.event} about ${wait.about} on ${wait.itemKey} from ${wait.workflowName}: ${reason}`
      );
  }
  return ok;
}

/**
 * Hand the starts observation recorded to their executors, host by host. A met wait is
 * closed when its receipt is recorded, so a later pass never observes it again: a host
 * whose drain fails stays owed and is drained again on this process's next pass. The owed
 * set lives only in this process; issue 6019 makes every wake pass drain the hosts the
 * install's trigger files name, which recovers a start after a restart too.
 */
async function drainOwed(
  host: WorkflowHost,
  observation: WakeObservation,
  owed: Set<string>,
  json: boolean
): Promise<boolean> {
  let ok = true;
  for (const hostId of [...owed]) {
    try {
      await drainResourceStartHost({
        ...host,
        hostId,
        startAdmitted: requestId => observation.dispatch(requestId, hostId),
      });
      owed.delete(hostId);
    } catch (drainError) {
      ok = false;
      const error = `host '${hostId}' drain failed: ${errorMessage(drainError)}`;
      const hint = `A running watch retries it on its next pass; otherwise run archon trigger drain --host ${hostId}.`;
      if (json) await writeJsonLine({ ok, action: 'observe', drain: hostId, error, hint });
      else console.error(`observe: ${error}. ${hint}`);
    }
  }
  return ok;
}

/** What the two loops of one `wake` share: whether it is stopping, and a sleep stop ends. */
interface WakeControl {
  stopped(): boolean;
  sleep(ms: number): Promise<void>;
}

/**
 * Observation's own loop. It runs beside the continuation loop, not inside it, because a
 * continuation pass awaits every resumed run to its end: a run that takes twenty minutes
 * must not hold the waits it is not part of for twenty minutes. A one-shot wake observes
 * once.
 */
/** A stop flag for both loops, and sleeps that a stop ends at once. */
function wakeControl(): { control: WakeControl; stop: () => void } {
  let stopped = false;
  const sleeps = new Set<() => void>();
  return {
    control: {
      stopped: () => stopped,
      sleep: ms =>
        new Promise<void>(resolve => {
          const done = (): void => {
            clearTimeout(timer);
            sleeps.delete(done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          sleeps.add(done);
        }),
    },
    stop: () => {
      stopped = true;
      for (const done of [...sleeps]) done();
    },
  };
}

async function observeLoop(
  host: WorkflowHost,
  observation: WakeObservation | undefined,
  watch: boolean,
  json: boolean,
  control: WakeControl
): Promise<boolean> {
  if (!observation) return true;
  // Hosts whose observed starts are not yet handed on; see `drainOwed`.
  const owed = new Set<string>();
  let ok = true;
  do {
    try {
      ok = (await observePass(host, observation, owed, json)) && ok;
    } catch (error) {
      ok = false;
      if (json) await writeJsonLine({ ok: false, action: 'observe', error: errorMessage(error) });
      else console.error(`observe: ${errorMessage(error)}`);
    }
    if (!watch || control.stopped()) break;
    await control.sleep(5_000);
  } while (!control.stopped());
  return ok;
}

async function wake(
  host: WorkflowHost,
  args: string[],
  values: Values,
  json: boolean,
  observation?: WakeObservation
): Promise<number> {
  validateFlags(values, ['watch']);
  if (args.length) throw new Error('Usage: archon workflow wake [--watch] [--json]');
  await announceObserving(observation, values.watch === true, json);
  const { control, stop } = wakeControl();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let ok = true;
  let observedOk = true;
  const observing = observeLoop(host, observation, values.watch === true, json, control);
  const loaded = await loadedEngine(values.watch === true, json);
  try {
    do {
      // Checked before every pass, so an update during the sleep never gets
      // another pass on the old engine.
      if (await engineChanged(loaded, json)) return WAKE_ENGINE_CHANGED_EXIT;
      const cleanups: (() => Promise<void>)[] = [];
      try {
        const outcomes = await wakeDueWorkflowContinuations(
          host.deps.store,
          new Date(),
          (run, cursor) => admit(host, run, cursor, cleanup => cleanups.push(cleanup))
        );
        ok = (await report('wake', await Promise.all(outcomes.map(settle)), json)) && ok;
      } catch (error) {
        ok = false;
        if (json) await writeJsonLine({ ok: false, action: 'wake', error: errorMessage(error) });
        else console.error(`wake: ${errorMessage(error)}`);
      } finally {
        await Promise.all(cleanups.map(cleanup => cleanup()));
      }
      if (!values.watch || control.stopped()) break;
      await control.sleep(5_000);
    } while (!control.stopped());
  } finally {
    // The observation loop ends with this one, after the pass it is in.
    stop();
    observedOk = await observing;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return [ok, observedOk].every(Boolean) ? 0 : 1;
}
