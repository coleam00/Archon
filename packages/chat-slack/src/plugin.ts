import type {
  ChatAttentionNoticeRequest,
  ChatAttentionNoticeResponse,
  ChatPlugin,
  ChatContext,
  ChatRunEvent,
  ChatSend,
  ChatResultFooter,
} from '@archon/chat-contract';
import { descriptor } from './descriptor';
import { SlackAdapter } from './adapter';
import { SlackWorkflowBridge } from './workflow-bridge';
import { SlackAttentionNotices } from './attention';

export class SlackPlugin implements ChatPlugin {
  readonly descriptor = descriptor;
  private bridge?: SlackWorkflowBridge;
  private notices?: SlackAttentionNotices;

  constructor(private readonly adapter = new SlackAdapter()) {}

  async start(ctx: ChatContext): Promise<void> {
    await this.adapter.start(ctx, () => {
      this.bridge = new SlackWorkflowBridge(this.adapter, ctx);
      this.bridge.attach();
      this.notices = new SlackAttentionNotices(this.adapter, ctx);
      this.notices.attach();
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

  attentionNotice(params: ChatAttentionNoticeRequest): Promise<ChatAttentionNoticeResponse> {
    if (!this.notices) throw new Error('Slack has not started');
    return this.notices.notice(params);
  }

  async stop(): Promise<void> {
    await this.bridge?.detach();
    this.notices?.detach();
    await this.adapter.stop();
  }
}
