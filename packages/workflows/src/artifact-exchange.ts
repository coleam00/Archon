import type { ArtifactExchange } from './container-context';

export const NODES_SUBDIR = 'nodes';

export class ArtifactExchangeError extends Error {
  constructor(operation: 'publish' | 'collect', cause: unknown) {
    super(`Artifact ${operation} failed`, { cause });
    this.name = 'ArtifactExchangeError';
  }
}

export async function withArtifactExchange<T>(
  exchange: ArtifactExchange | undefined,
  invoke: () => Promise<T>
): Promise<T> {
  if (!exchange) return invoke();
  await publishArtifactInputs(exchange);
  let result: T;
  try {
    result = await invoke();
  } catch (invocationError) {
    try {
      await exchange.collect();
    } catch (collectionError) {
      throw new ArtifactExchangeError(
        'collect',
        new AggregateError([invocationError, collectionError], 'Invocation and collection failed')
      );
    }
    throw invocationError;
  }
  try {
    await exchange.collect();
  } catch (cause) {
    throw new ArtifactExchangeError('collect', cause);
  }
  return result;
}

export async function publishArtifactInputs(exchange: ArtifactExchange | undefined): Promise<void> {
  if (!exchange) return;
  try {
    await exchange.publish();
  } catch (cause) {
    throw new ArtifactExchangeError('publish', cause);
  }
}
