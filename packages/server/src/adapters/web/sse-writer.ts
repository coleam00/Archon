import type { SSEStreamingApi } from 'hono/streaming';
import type { SSEWriter } from './transport';

export function checkedSSEWriter(stream: SSEStreamingApi): SSEWriter {
  return {
    get closed() {
      return stream.closed || stream.aborted;
    },
    async writeSSE(message) {
      if (stream.closed || stream.aborted) throw new Error('SSE stream is disconnected');
      await stream.writeSSE(message);
      // Hono swallows sink rejection on response cancellation and sets aborted instead.
      if (stream.closed || stream.aborted) throw new Error('SSE stream disconnected during write');
    },
    close: () => stream.close(),
  };
}
