import type { IAgentProvider } from '@archon/provider-contract';
/** The part of a provider this helper touches; test mocks type their chunks loosely. */
interface QueryingProvider {
  sendQuery(...args: never[]): AsyncIterable<unknown> | Iterable<unknown>;
}

/**
 * Mock providers in engine tests stand in for conforming providers, which end every turn
 * with `settled`. This wraps a mock so a turn whose stream completes without one gets it
 * appended. A test about a provider that breaks the contract uses the raw mock instead.
 */
export function settlingProvider<P extends QueryingProvider>(provider: P): P {
  const sendQuery = (...args: Parameters<P['sendQuery']>): AsyncGenerator =>
    settleAtEnd(provider.sendQuery(...args));
  const checkCredential: IAgentProvider['checkCredential'] = async () => ({
    state: 'not_checked',
    source: 'native',
  });
  return { checkCredential, ...provider, sendQuery } as P;
}

async function* settleAtEnd(stream: AsyncIterable<unknown> | Iterable<unknown>): AsyncGenerator {
  let settled = false;
  for await (const chunk of stream) {
    if ((chunk as { type?: unknown }).type === 'settled') settled = true;
    yield chunk;
  }
  if (!settled) yield { type: 'settled' };
}
