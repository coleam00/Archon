import { serveProvider } from '@archon/provider-contract/plugin';
import { installProviderLogSink } from '../shared/plugin-logging';
import { createProvider, descriptor } from './index';
export { createProvider, descriptor };

if (import.meta.main) {
  await serveProvider({
    descriptor,
    create: log => {
      installProviderLogSink(log);
      return createProvider();
    },
  });
}
