/** Minimal type declarations for zulip-js (no official @types package available). */
declare module 'zulip-js' {
  interface ZulipClientConfig {
    realm: string;
    username: string;
    apiKey: string;
  }

  interface ZulipQueueResult {
    queue_id: string;
    last_event_id: number;
  }

  interface ZulipEventResult {
    events: { type: string; id: number; message?: unknown; message_id?: number }[];
  }

  interface ZulipStreamMessageParams {
    type: 'stream';
    to: number;
    topic: string;
    content: string;
  }

  interface ZulipPrivateMessageParams {
    type: 'private';
    // JSON-encoded array of user IDs (e.g. `JSON.stringify([1, 2, 3])`). The Zulip REST API
    // wants a string here, NOT a literal array — on the wire this is `to: "[1,2,3]"`.
    // (The adapter currently bypasses `client.messages.send` for POSTs via `zulipPost`, but
    // this type guides any direct caller of `ZulipClient.messages.send`.)
    to: string;
    content: string;
  }

  interface ZulipClient {
    users: {
      me: {
        getProfile: () => Promise<{ full_name: string }>;
      };
    };
    queues: {
      register: (opts: {
        event_types: string[];
        apply_markdown?: boolean;
      }) => Promise<ZulipQueueResult>;
    };
    events: {
      retrieve: (opts: {
        queue_id: string;
        last_event_id: number;
        dont_block?: boolean;
      }) => Promise<ZulipEventResult>;
    };
    messages: {
      send: (params: ZulipStreamMessageParams | ZulipPrivateMessageParams) => Promise<void>;
      retrieve: (params: {
        anchor: string | number;
        num_before: number;
        num_after: number;
        narrow: { operator: string; operand: string }[];
        apply_markdown?: boolean;
      }) => Promise<{ messages: unknown[] }>;
    };
  }

  function zulip(config: ZulipClientConfig): Promise<ZulipClient>;
  export = zulip;
}
