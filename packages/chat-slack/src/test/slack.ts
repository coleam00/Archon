import type { App, BlockButtonAction, ButtonAction } from '@slack/bolt';
import type { SlackMessageEvent } from '../adapter';

type Post = Parameters<App['client']['chat']['postMessage']>[0];
type Update = Parameters<App['client']['chat']['update']>[0];
type Ephemeral = Parameters<App['client']['chat']['postEphemeral']>[0];
type Reaction = Parameters<App['client']['reactions']['add']>[0];
type Command = Parameters<App['command']>[1];
type EventHandler = (args: {
  event: SlackMessageEvent & { channel_type?: string; bot_id?: string };
}) => Promise<void>;
type ActionHandler = (args: {
  ack: () => Promise<void>;
  body: BlockButtonAction;
  action: ButtonAction;
}) => Promise<void>;

export class StubSlack {
  posts: Post[] = [];
  updates: Update[] = [];
  ephemerals: Ephemeral[] = [];
  added: Reaction[] = [];
  removed: Reaction[] = [];
  events = new Map<string, EventHandler>();
  commands = new Map<string, Command>();
  actions: { pattern: RegExp; handler: ActionHandler }[] = [];
  userLookups = 0;
  historyLookups = 0;
  displayName = 'Alice';
  replies: { ts?: string; text?: string; user?: string; bot_id?: string }[] = [];
  failPost?: Error;
  failUpdate?: Error;
  failUser?: Error;
  failHistory?: Error;
  missingTs = false;
  started = false;
  stopped = false;
  failNextRender = false;
  rendered?: () => void;
  postBarrier?: Promise<void>;

  client = {
    chat: {
      postMessage: async (args: Post) => {
        if (this.failPost) {
          const error = this.failPost;
          this.failPost = undefined;
          throw error;
        }
        this.posts.push(args);
        await this.postBarrier;
        return { ok: true, ts: this.missingTs ? undefined : `msg-${String(this.posts.length)}` };
      },
      update: async (args: Update) => {
        if (this.failNextRender) {
          this.failNextRender = false;
          this.rendered?.();
          throw new Error('fixture render failure');
        }
        if (this.failUpdate) throw this.failUpdate;
        this.updates.push(args);
        return { ok: true };
      },
      postEphemeral: async (args: Ephemeral) => {
        this.ephemerals.push(args);
        return { ok: true };
      },
    },
    users: {
      info: async () => {
        this.userLookups++;
        if (this.failUser) throw this.failUser;
        return { ok: true, user: { real_name: this.displayName } };
      },
    },
    conversations: {
      replies: async () => {
        this.historyLookups++;
        if (this.failHistory) throw this.failHistory;
        return { ok: true, messages: this.replies };
      },
    },
    reactions: {
      add: async (args: Reaction) => {
        this.added.push(args);
        return { ok: true };
      },
      remove: async (args: Reaction) => {
        this.removed.push(args);
        return { ok: true };
      },
    },
  };

  event(name: string, handler: EventHandler): void {
    this.events.set(name, handler);
  }
  command(name: string, handler: Command): void {
    this.commands.set(name, handler);
  }
  action(pattern: RegExp, handler: ActionHandler): void {
    this.actions.push({ pattern, handler });
  }
  error(): void {}
  async start(): Promise<void> {
    if (this.events.size !== 2 || this.commands.size !== 2 || this.actions.length !== 2)
      throw new Error('handlers must register before start');
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }

  asApp(): App {
    // The double implements only the Bolt surface used by this plugin.
    return this as unknown as App;
  }
}
