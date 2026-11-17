/**
 * The item tracker pass a CLI process owes before it exits. A process that built a host
 * able to start, resume or pause runs, or that ended a run, brings every tracked
 * project's tracker up to date on its way out, so the tracker needs no running server.
 *
 * Everything heavier than the logger loads on use: CLI startup imports this module.
 */
import { createLogger } from '@archon/paths';

/** An activated tracker, as the exit pass uses it. */
export interface ExitTracker {
  scan(options: { request: boolean }): Promise<unknown>;
}

/** Activate the configured tracker; undefined when nothing is tracked. */
export type ActivateTracker = (
  forgeTrustedEnv: NodeJS.ProcessEnv
) => Promise<ExitTracker | undefined>;

export interface TrackerExit {
  /**
   * Before this process can start, resume or pause a run: activate the tracker and owe a
   * pass at exit. A project's first activation records everything already on its items as
   * shown, so activating after the run would hide that run for good.
   */
  prepare(forgeTrustedEnv: NodeJS.ProcessEnv): Promise<void>;
  /** This process ended a run on a host that did not prepare. */
  markOwed(): void;
  /**
   * Run the owed pass. It never fails the command: a failure is logged, and what the pass
   * did not write stays owed in the tracker's ledger for the next pass.
   */
  syncIfOwed(forgeTrustedEnv: NodeJS.ProcessEnv): Promise<void>;
}

export function createTrackerExit(activate: ActivateTracker = activateWhenConfigured): TrackerExit {
  const log = () => createLogger('cli.item-tracker');
  let owed = false;
  let prepared: Promise<ExitTracker | undefined> | undefined;
  // A failed activation is not retried at exit: that later activation is the one that
  // would hide the run.
  const activateLogged = (env: NodeJS.ProcessEnv): Promise<ExitTracker | undefined> =>
    activate(env).catch((err: unknown) => {
      log().error({ err }, 'item_tracker.activation_failed');
      return undefined;
    });
  return {
    async prepare(forgeTrustedEnv) {
      owed = true;
      prepared ??= activateLogged(forgeTrustedEnv);
      await prepared;
    },
    markOwed() {
      owed = true;
    },
    async syncIfOwed(forgeTrustedEnv) {
      if (!owed) return;
      owed = false;
      const tracker = await (prepared ?? activateLogged(forgeTrustedEnv));
      try {
        await tracker?.scan({ request: true });
      } catch (err) {
        log().error({ err }, 'item_tracker.exit_pass_failed');
      }
    },
  };
}

/** This process's tracker pass. */
export const trackerExit = createTrackerExit();

/** Items live only in the SQL stores, so a file-store install has nothing to track. */
async function activateWhenConfigured(
  forgeTrustedEnv: NodeJS.ProcessEnv
): Promise<ExitTracker | undefined> {
  const { usesDatabaseStore, markDatabaseRouteLoaded } = await import('../routes/route-loader');
  if (!(await usesDatabaseStore())) return undefined;
  // The tracker opens the database; the command's cleanup closes it.
  markDatabaseRouteLoaded();
  const { activateConfiguredTracker } = await import('../commands/tracker');
  return activateConfiguredTracker(forgeTrustedEnv);
}
