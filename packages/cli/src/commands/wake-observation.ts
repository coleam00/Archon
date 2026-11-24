/**
 * Builds what `workflow wake` observes from `ARCHON_WEBHOOK_SOURCES`. Kept apart from the
 * route so the route stays a thin mapping onto commands; loaded only by `wake` and by
 * `trigger check`, which reports what nothing watches.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type {
  ObservingSource,
  WebhookSourcePluginHost,
} from '@archon/core/workflows/source-plugins';
import {
  inspectNativeSchedule,
  NativeScheduleUnsupportedError,
  type NativeScheduleOptions,
} from '../triggers/native-schedule';
import {
  describeWakeLastPass,
  readWakeLastPass,
  WAKE_SCHEDULE_INSTALL_COMMAND,
  wakeLastPassPath,
  workflowWakeScheduleTarget,
} from './wake-schedule';
import type { WakeObservation } from './workflow-continuations';

/**
 * The sources in `ARCHON_WEBHOOK_SOURCES` that declare `observe`, loaded as `wake` loads
 * them; `undefined` when the variable is not set.
 */
async function loadObservingSources(
  host: WorkflowHost,
  configPath = process.env.ARCHON_WEBHOOK_SOURCES
): Promise<WebhookSourcePluginHost | undefined> {
  if (!configPath) return undefined;
  const { loadWebhookSourcePlugins } = await import('@archon/core/workflows/source-plugins');
  const { store } = host.deps;
  return loadWebhookSourcePlugins(
    configPath,
    {
      acceptReceipt: input => store.acceptStartReceipt(input),
      isKnownUser: async id => (await host.records.users.getUserById(id)) !== null,
      hasDeliveryReceipt: (sourceInstanceId, deliveryId) =>
        store.hasStartReceiptForDelivery(sourceInstanceId, deliveryId),
      getReceipt: id => store.getStartReceipt(id),
    },
    // Wake receives no webhooks: a source that does not observe is never loaded here.
    { observingOnly: true }
  );
}

/**
 * The sources that observe, as `trigger check` reports them; none when nothing observes.
 * Without ARCHON_WEBHOOK_SOURCES here, the file the installed job's watcher last loaded is
 * read: install passes the installing shell's file to the job with `--sources`.
 */
async function observingSources(host: WorkflowHost): Promise<readonly ObservingSource[]> {
  const configPath =
    process.env.ARCHON_WEBHOOK_SOURCES || (await readWakeLastPass(wakeLastPassPath()))?.sources;
  return (await loadObservingSources(host, configPath))?.observing ?? [];
}

/**
 * The sources that observe (event bindings on an install with no webhooks) and whether this
 * host's scheduler runs the wake watcher that reads them; `undefined` when none observes.
 * A report, not a problem: a server started with ARCHON_WEBHOOK_SOURCES observes too, and
 * check cannot tell whether one runs for this install.
 */
export async function observingReport(host: WorkflowHost, schedules: NativeScheduleOptions) {
  const sources = (await observingSources(host)).map(source => ({
    source: source.sourceInstanceId,
    everySeconds: source.everySeconds,
    labels: source.labels,
  }));
  if (sources.length === 0) return undefined;
  const server = `an Archon server started with ARCHON_WEBHOOK_SOURCES runs for this install`;
  try {
    const target = workflowWakeScheduleTarget();
    const job = await inspectNativeSchedule(target, schedules);
    const watcher = { installed: job !== undefined, registered: job?.registered ?? false };
    if (watcher.registered) {
      // The job discards the watcher's output; its last pass is the one sign of a watcher
      // that runs but fails every pass, for example on a binding's unknown run-as user.
      const lastPass = await readWakeLastPass(wakeLastPassPath(target));
      return {
        sources,
        watcher: { ...watcher, ...(lastPass ? { lastPass } : {}) },
        unwatched: false,
        ...(lastPass && (!lastPass.ok || lastPass.lastFailure)
          ? {
              problem: `The wake watcher runs, but ${describeWakeLastPass(lastPass).replace(/^Its/, 'its')}`,
            }
          : {}),
      };
    }
    return {
      sources,
      watcher,
      unwatched: true,
      fix: `Nothing on this host's scheduler runs archon workflow wake --watch, so these sources are observed only while ${server}. Run ${WAKE_SCHEDULE_INSTALL_COMMAND}.`,
    };
  } catch (error) {
    if (!(error instanceof NativeScheduleUnsupportedError)) throw error;
    return {
      sources,
      watcher: { supported: false },
      unwatched: true,
      fix: `This host has no scheduler Archon can install the wake watcher with, so these sources are observed only while archon workflow wake --watch runs under a supervisor of your own, or while ${server}.`,
    };
  }
}

/**
 * What `workflow wake` observes for an install that receives no webhooks: the sources in
 * `ARCHON_WEBHOOK_SOURCES` that declare `observe`, or nothing when none does.
 */
export async function wakeObservation(
  host: WorkflowHost,
  forgeTrustedEnv: NodeJS.ProcessEnv
): Promise<WakeObservation | undefined> {
  const sources = await loadObservingSources(host);
  if (!sources) return undefined;
  const [{ createItemWaitObserver }, { hostSourceForgeReader }] = await Promise.all([
    import('@archon/core/workflows/source-plugins'),
    import('@archon/adapters/forge/source-forge-reader'),
  ]);
  const observer = createItemWaitObserver({
    sources,
    store: host.deps.store,
    forge: hostSourceForgeReader(forgeTrustedEnv, process.env),
  });
  if (!observer) return undefined;
  const { spawnAdmitted } = await import('../utils/spawn-admitted');
  return { observer, dispatch: (requestId, hostId) => spawnAdmitted(host, requestId, hostId) };
}
