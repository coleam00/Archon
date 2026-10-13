import type {
  ChatPlugin,
  ChatContext,
  ChatRunEvent,
  ChatSend,
  ChatResultFooter,
} from '@archon/chat-contract';
import { descriptor } from './descriptor';
import { SlackAdapter } from './adapter';
import { SlackWorkflowBridge } from './workflow-bridge';

export class SlackPlugin implements ChatPlugin {
  readonly descriptor = descriptor;
  private bridge?: SlackWorkflowBridge;
  private events = Promise.resolve();

  constructor(private readonly adapter = new SlackAdapter()) {}

  async start(ctx: ChatContext): Promise<void> {
    await this.adapter.start(ctx, () => {
      this.bridge = new SlackWorkflowBridge(this.adapter, ctx);
      this.bridge.attach();
    });
  }

  send(params: ChatSend): Promise<void> {
    return this.adapter.send(params);
  }
  resultFooter(params: ChatResultFooter): Promise<void> {
    return this.adapter.resultFooter(params);
  }

  onRunEvent(event: ChatRunEvent): Promise<void> {
    // Notifications are dispatched concurrently by the peer; Slack edits need emission order.
    const rendering = this.events.then(() => this.bridge?.handleEvent(event));
    this.events = rendering.catch(() => undefined);
    return rendering;
  }

  async stop(): Promise<void> {
    await this.events;
    this.bridge?.detach();
    await this.adapter.stop();
  }
}
