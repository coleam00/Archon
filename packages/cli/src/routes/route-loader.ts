import { BUNDLED_IS_BINARY, getPluginsPath, shutdownTelemetry } from '@archon/paths';
import { exitWithDrain } from '../utils/exit-with-drain';
import { getLog } from './context';

let providersRegistered = false;
let databaseRouteLoaded = false;
let providerProcessErrorHandlersInstalled = false;

function installProviderProcessErrorHandlers(
  claimPiExtensionProcessError: (reason: unknown) => boolean
): void {
  if (providerProcessErrorHandlersInstalled) return;
  providerProcessErrorHandlersInstalled = true;

  const exitForUnhandledError = (
    reason: unknown,
    event: 'unhandled_rejection' | 'uncaught_exception',
    origin?: NodeJS.UncaughtExceptionOrigin
  ): void => {
    getLog().fatal({ reason, origin }, `${event}.fatal`);
    void shutdownTelemetry()
      .catch((error: unknown) => {
        getLog().error({ err: error }, 'telemetry_shutdown_failed');
      })
      .then(() => exitWithDrain(1));
  };

  process.on('unhandledRejection', reason => {
    if (!claimPiExtensionProcessError(reason)) {
      exitForUnhandledError(reason, 'unhandled_rejection');
    }
  });
  process.on('uncaughtException', (error, origin) => {
    if (!claimPiExtensionProcessError(error)) {
      exitForUnhandledError(error, 'uncaught_exception', origin);
    }
  });
}

export async function registerProviders(): Promise<void> {
  if (providersRegistered) return;
  const { registerHostProviders } = await import('@archon/core/providers/register-host-providers');
  const { setDeprecationReporter } = await import('@archon/providers');
  // stderr, like a deprecated workflow's notice: it survives --json's log silencing.
  setDeprecationReporter((_provider, notice) => console.warn(notice));
  if (BUNDLED_IS_BINARY) {
    const { claimPiExtensionProcessError } = await import(
      '@archon/providers/pi/extension-error-broker'
    );
    installProviderProcessErrorHandlers(claimPiExtensionProcessError);
  }
  await registerHostProviders();
  providersRegistered = true;
}

export async function usesDatabaseStore(): Promise<boolean> {
  const { loadStoreSelection } = await import('@archon/core/config/store-selection');
  return (await loadStoreSelection()) === 'database';
}

/** Records that this invocation opened the database, so `closeDb` closes it. */
export function markDatabaseRouteLoaded(): void {
  databaseRouteLoaded = true;
}

export async function loadRoute<T>(
  loader: () => Promise<T>,
  options: { providers?: false; database?: boolean } = {}
): Promise<T> {
  const [{ setPlatformPolicies }, { defaultPlatformPolicies }, { loadPlatformPolicies }] =
    await Promise.all([
      import('@archon/core/platforms/registry'),
      import('@archon/adapters/platform-policies'),
      import('@archon/core/platforms/chat-plugins'),
    ]);
  setPlatformPolicies(await loadPlatformPolicies(getPluginsPath(), defaultPlatformPolicies));
  if (options.providers !== false) await registerProviders();
  if (options.database) {
    const { loadStoreSelection } = await import('@archon/core/config/store-selection');
    if ((await loadStoreSelection()) === 'files') {
      const { FileStoreUnsupportedError: fileStoreUnsupportedError } = await import(
        '@archon/workflows/file-store'
      );
      throw new fileStoreUnsupportedError('this SQL-only CLI command');
    }
    databaseRouteLoaded = true;
  }
  return loader();
}

/**
 * Safely close the database connection
 */
export async function closeDb(): Promise<void> {
  if (!databaseRouteLoaded) return;
  try {
    const { closeDatabase } = await import('@archon/core/db/connection');
    await closeDatabase();
  } catch (error) {
    const err = error as Error;
    // Log with details but don't throw - we want the original error to be visible
    getLog().warn({ err }, 'db_close_failed');
  }
}
