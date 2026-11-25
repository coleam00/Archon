import { join } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { loadStoreSelection } from '@archon/core/config/store-selection';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import { trackerExit } from './tracker-exit';
import { engineChangedSinceLoad, recordLoadedEngine } from './engine-fingerprint';

/** A host that executes workflows: it can start, resume or pause runs. */
export interface CliWorkflowExecution {
  forgeTrustedEnv: NodeJS.ProcessEnv;
}

/** Where the file store keeps its history: `<ARCHON_HOME>/store`. */
export function getFileStoreRoot(): string {
  return join(getArchonHome(), 'store');
}

/**
 * `executorHost` is set only in a `trigger execute --host <hostId>` process: a drain of
 * that host handed it its run, so its run end drains that host too, beside the hosts the
 * install's trigger files name. No other process has a host of its own here.
 */
export async function createCliWorkflowHost(
  execution?: CliWorkflowExecution,
  executorHost?: string
): Promise<WorkflowHost> {
  const executesWorkflow = execution !== undefined;
  recordLoadedEngine();
  if (execution) await trackerExit.prepare(execution.forgeTrustedEnv);
  // Set once the host exists: what a run's end starts runs through the whole host.
  let host: WorkflowHost | undefined;
  const wrapStore = async <S extends IWorkflowStore>(store: S): Promise<S> => {
    const { drainAfterRunEnds } = await import('@archon/core/workflows/run-end-drain');
    return drainAfterRunEnds(store, await afterRunEnded(() => host, executorHost));
  };
  if ((await loadStoreSelection()) === 'files') {
    if (executesWorkflow) {
      const { initializeWorkflowGitHubAppAuth } = await import(
        '@archon/core/workflows/store-adapter'
      );
      initializeWorkflowGitHubAppAuth();
    }
    const { createFileWorkflowHost } = await import('@archon/core/workflows/file-host');
    host = await createFileWorkflowHost(getFileStoreRoot(), wrapStore);
    return host;
  }
  const { createSqlWorkflowHost } = await import('@archon/core/workflows/sql-host');
  const { createWorkflowDeps } = await import('@archon/core/workflows/store-adapter');
  const deps = executesWorkflow
    ? (await import('./workflow-deps')).createCliWorkflowDeps()
    : createWorkflowDeps();
  host = createSqlWorkflowHost({ ...deps, store: await wrapStore(deps.store) });
  return host;
}

/**
 * After a run this process ended, or a set of asks this process settled: start the starts
 * its completion or settlement wrote, each on the host its binding names, as `trigger fire`
 * starts its receipt; then drain every host this install serves (`drainInstallHosts`), so
 * a start queued behind the slot the run released is admitted whoever started that run.
 * Each admitted run starts in its own detached `trigger execute` process.
 */
async function afterRunEnded(
  getHost: () => WorkflowHost | undefined,
  executorHost: string | undefined
): Promise<(runId: string, caused: readonly SourceReceiptAcceptance[]) => Promise<void>> {
  const { serializedDrain } = await import('@archon/core/workflows/run-end-drain');
  // Loaded only when an end happens, so a process that ends no run pays nothing.
  const starting = async (host: WorkflowHost) => {
    const [{ startReceiptBindings }, { spawnAdmitted }, { drainInstallHosts }] = await Promise.all([
      import('@archon/core/workflows/resource-start-host'),
      import('./spawn-admitted'),
      import('./install-hosts'),
    ]);
    const dispatch = (requestId: string, hostId: string) => spawnAdmitted(host, requestId, hostId);
    return { startReceiptBindings, drainInstallHosts, dispatch };
  };
  const drainInstall = serializedDrain(async () => {
    const host = getHost();
    if (!host) return;
    const { drainInstallHosts, dispatch } = await starting(host);
    const { failures } = await drainInstallHosts(host, { executorHost, dispatch });
    if (failures.length > 0)
      throw new AggregateError(
        failures.map(failure => failure.error),
        "Draining this install's hosts failed"
      );
  });
  return async (runId, caused) => {
    // Called for every run end this process wrote, from any host it built.
    trackerExit.markOwed();
    const host = getHost();
    if (!host) return;
    createLogger('cli.run-end-drain').debug(
      { workflowRunId: runId, executorHost, caused: caused.length },
      'run_end_drain'
    );
    const byHost = new Map<string, Set<string>>();
    for (const { receipt, bindings } of caused)
      for (const binding of bindings) {
        const ids = byHost.get(binding.hostId) ?? new Set<string>();
        ids.add(receipt.id);
        byHost.set(binding.hostId, ids);
      }
    if (engineChangedSinceLoad()) {
      await handOffToInstalledEngine(runId, [...byHost.keys()], executorHost);
      return;
    }
    // One host's failure must not keep the others, or the install's drain, from running.
    const failures: unknown[] = [];
    if (byHost.size > 0) {
      const { startReceiptBindings, dispatch } = await starting(host);
      for (const [hostId, receiptIds] of byHost)
        await startReceiptBindings(
          {
            ...host,
            hostId,
            startAdmitted: requestId => dispatch(requestId, hostId),
            engineChanged: engineChangedSinceLoad,
          },
          receiptIds
        ).catch((error: unknown) => {
          failures.push(error);
        });
    }
    await drainInstall().catch((error: unknown) => {
      failures.push(error);
    });
    if (failures.length > 0)
      throw new AggregateError(failures, 'A start after the run ended failed');
  };
}

/**
 * The hand-off of a run that ended on an engine the install has since replaced: this
 * process prepares nothing, since its code may not load definitions written for the new
 * engine. Its starts stay pending, and it starts the installed CLI's `trigger drain` for
 * each host they or this install name, in the background, so a CLI-only install with no
 * wake job still hands off. A drain that cannot be started leaves the starts pending for
 * the next drain of their host (a run end, a wake pass, `trigger drain`), and is logged.
 */
async function handOffToInstalledEngine(
  runId: string,
  causedHosts: readonly string[],
  executorHost: string | undefined
): Promise<void> {
  const log = createLogger('cli.run-end-drain');
  const [
    { installHosts },
    { startTriggerExecutor },
    { cliProgramArguments },
    { DETACHED_RUN_OWNER_ENV },
    { mkdir },
  ] = await Promise.all([
    import('./install-hosts'),
    import('./run-job-escape'),
    import('./cli-program-arguments'),
    import('./detached-run-control'),
    import('node:fs/promises'),
  ]);
  const hostIds = [...new Set([...causedHosts, ...(await installHosts(executorHost)).hostIds])];
  log.info({ workflowRunId: runId, hostIds }, 'run_end_drain.engine_changed');
  const logDirectory = join(getArchonHome(), 'logs');
  await mkdir(logDirectory, { recursive: true });
  for (const hostId of hostIds) {
    try {
      await startTriggerExecutor(
        {
          args: ['trigger', 'drain', '--host', hostId],
          cwd: getArchonHome(),
          // The drain owns no run; empty, not deleted, so `.env` loading cannot restore it.
          env: { ...process.env, ARCHON_HOME: getArchonHome(), [DETACHED_RUN_OWNER_ENV]: '' },
          log: join(logDirectory, `run-end-drain-${runId}.log`),
        },
        cliProgramArguments()
      );
    } catch (error) {
      log.error(
        { err: error as Error, workflowRunId: runId, hostId },
        'run_end_drain.installed_engine_spawn_failed'
      );
    }
  }
}
