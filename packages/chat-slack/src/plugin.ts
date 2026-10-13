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
    return this.bridge?.handleEvent(event) ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    await this.bridge?.detach();
    await this.adapter.stop();
  }
}
