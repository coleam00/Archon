import { serveProvider } from '@archon/provider-contract/plugin';
import { installProviderLogSink } from '../../shared/plugin-logging';
import { createProvider, descriptor } from './index';
import { claimPiExtensionProcessError } from './extension-error-broker';
export { createProvider, descriptor };

if (import.meta.main) {
  const exitUnhandled = (reason: unknown): void => {
    if (claimPiExtensionProcessError(reason)) return;
    process.stderr.write('pi.unhandled_process_error\n');
    process.exit(1);
  };
  process.on('unhandledRejection', exitUnhandled);
  process.on('uncaughtException', exitUnhandled);
  await serveProvider({
    descriptor,
    create: log => {
      installProviderLogSink(log);
      return createProvider();
    },
  });
}
