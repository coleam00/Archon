/**
 * The item tracker pass a CLI process owes before it exits. A process that built a host
 * able to start, resume or pause runs, or that ended a run, brings every tracked
 * project's tracker up to date on its way out, so the tracker needs no running server.
 *
 * Everything heavier than the logger loads on use: CLI startup imports this module.
 */
import { createLogger } from '@archon/paths';

let owed = false;

export function markTrackerPassOwed(): void {
  owed = true;
}

type TrackerSync = (forgeTrustedEnv: NodeJS.ProcessEnv) => Promise<unknown>;

/**
 * Run the owed pass. It never fails the command: a failure is logged, and what the pass
 * did not write stays owed in the tracker's ledger for the next pass. Items live only in
 * the SQL stores, so a file-store install has nothing to track.
 */
export async function syncTrackerIfOwed(
  forgeTrustedEnv: NodeJS.ProcessEnv,
  sync: TrackerSync = syncWhenConfigured
): Promise<void> {
  if (!owed) return;
  owed = false;
  try {
    await sync(forgeTrustedEnv);
  } catch (err) {
    createLogger('cli.item-tracker').error({ err }, 'item_tracker.exit_pass_failed');
  }
}

async function syncWhenConfigured(forgeTrustedEnv: NodeJS.ProcessEnv): Promise<void> {
  const { usesDatabaseStore, markDatabaseRouteLoaded, registerProviders } = await import(
    '../routes/route-loader'
  );
  if (!(await usesDatabaseStore())) return;
  // The config names its default provider, which loading it checks against the registry.
  await registerProviders();
  const { loadConfig } = await import('@archon/core/config/config-loader');
  const { itemTracker } = await loadConfig();
  if (!itemTracker) return;
  // The pass opens the database; the command's cleanup closes it.
  markDatabaseRouteLoaded();
  const { syncTrackedProjects } = await import('../commands/tracker');
  await syncTrackedProjects(itemTracker, forgeTrustedEnv);
}
