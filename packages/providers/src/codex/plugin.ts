import { serveProvider } from '@archon/provider-contract/plugin';
import { installProviderLogSink } from '../shared/plugin-logging';
import { CodexProvider } from './provider';
import type { Spawner } from './app-server';
import { descriptor } from './descriptor';
export { descriptor };

// The plugin host owns cancellation and cleanup of this process group, including native children.
export function createProvider(spawner?: Spawner, shutdownGraceMs?: number): CodexProvider {
  return new CodexProvider(spawner, shutdownGraceMs, 'host');
}

if (import.meta.main) {
  await serveProvider({
    descriptor,
    create: log => {
      installProviderLogSink(log);
      return createProvider();
    },
  });
}
