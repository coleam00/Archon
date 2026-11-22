/**
 * Builds what `workflow wake` observes from `ARCHON_WEBHOOK_SOURCES`. Kept apart from the
 * route so the route stays a thin mapping onto commands, and loaded only by `wake`.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WakeObservation } from './workflow-continuations';

/**
 * What `workflow wake` observes for an install that receives no webhooks: the sources in
 * `ARCHON_WEBHOOK_SOURCES` that declare `observe`, or nothing when none does.
 */
export async function wakeObservation(
  host: WorkflowHost,
  forgeTrustedEnv: NodeJS.ProcessEnv
): Promise<WakeObservation | undefined> {
  const configPath = process.env.ARCHON_WEBHOOK_SOURCES;
  if (!configPath) return undefined;
  const [{ createItemWaitObserver, loadWebhookSourcePlugins }, { hostSourceForgeReader }] =
    await Promise.all([
      import('@archon/core/workflows/source-plugins'),
      import('@archon/adapters/forge/source-forge-reader'),
    ]);
  const { store } = host.deps;
  const sources = await loadWebhookSourcePlugins(
    configPath,
    {
      acceptReceipt: input => store.acceptStartReceipt(input),
      isKnownUser: async id => (await host.records.users.getUserById(id)) !== null,
      hasDeliveryReceipt: (sourceInstanceId, deliveryId) =>
        store.hasStartReceiptForDelivery(sourceInstanceId, deliveryId),
    },
    // Wake receives no webhooks: a source that does not observe is never loaded here.
    { observingOnly: true }
  );
  const observer = createItemWaitObserver({
    sources,
    store,
    forge: hostSourceForgeReader(forgeTrustedEnv, process.env),
  });
  if (!observer) return undefined;
  const { spawnAdmitted } = await import('../utils/spawn-admitted');
  return { observer, dispatch: (requestId, hostId) => spawnAdmitted(host, requestId, hostId) };
}
