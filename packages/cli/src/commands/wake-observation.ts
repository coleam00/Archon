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
import type { WakeObservation } from './workflow-continuations';

/**
 * The sources in `ARCHON_WEBHOOK_SOURCES` that declare `observe`, loaded as `wake` loads
 * them; `undefined` when the variable is not set.
 */
async function loadObservingSources(
  host: WorkflowHost
): Promise<WebhookSourcePluginHost | undefined> {
  const configPath = process.env.ARCHON_WEBHOOK_SOURCES;
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

/** What `trigger check` reports as observed: the observing sources, or none. */
export async function observingSources(host: WorkflowHost): Promise<readonly ObservingSource[]> {
  return (await loadObservingSources(host))?.observing ?? [];
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
