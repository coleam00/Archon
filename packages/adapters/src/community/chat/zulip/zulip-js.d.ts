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
    to: number[];
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
