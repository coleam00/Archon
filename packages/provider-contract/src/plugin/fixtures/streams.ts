import type { ProviderPluginIO } from '../rpc';

export function streamPair(observe?: (side: 'host' | 'provider', value: Uint8Array) => void): {
  host: ProviderPluginIO;
  provider: ProviderPluginIO;
} {
  function stream(side: 'host' | 'provider'): TransformStream<Uint8Array, Uint8Array> {
    return new TransformStream({
      transform(value, controller): void {
        observe?.(side, value);
        controller.enqueue(value);
      },
    });
  }
  const outgoing = stream('host');
  const incoming = stream('provider');
  return {
    host: { readable: incoming.readable, writable: outgoing.writable },
    provider: { readable: outgoing.readable, writable: incoming.writable },
  };
}
