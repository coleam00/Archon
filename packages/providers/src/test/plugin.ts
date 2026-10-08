import type { IAgentProvider } from '@archon/provider-contract';
import {
  connectProvider,
  serveProvider,
  type ConnectedProvider,
  type ProviderPluginDescriptor,
} from '@archon/provider-contract/plugin';
import { streamPair } from '../../../provider-contract/src/plugin/fixtures/streams';

export async function withStreamProvider<T>(
  create: () => IAgentProvider,
  descriptor: ProviderPluginDescriptor,
  run: (provider: ConnectedProvider) => Promise<T>
): Promise<T> {
  const pair = streamPair();
  const serving = serveProvider({ descriptor, create }, pair.provider);
  const client = await connectProvider(pair.host);
  try {
    return await run(client);
  } finally {
    await client.close();
    await serving;
  }
}

export function overStreams(
  create: () => IAgentProvider,
  descriptor: ProviderPluginDescriptor
): IAgentProvider {
  return {
    getType: () => descriptor.id,
    getCapabilities: () => descriptor.capabilities,
    checkCredential: request =>
      withStreamProvider(create, descriptor, client => client.checkCredential(request)),
    diagnose: request => withStreamProvider(create, descriptor, client => client.diagnose(request)),
    listModels: () => withStreamProvider(create, descriptor, client => client.listModels()),
    async *sendQuery(...args) {
      const pair = streamPair();
      const serving = serveProvider({ descriptor, create }, pair.provider);
      const client = await connectProvider(pair.host);
      try {
        yield* client.sendQuery(...args);
      } finally {
        await client.close();
        await serving;
      }
    },
  };
}
