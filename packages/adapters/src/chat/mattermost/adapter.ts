import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import { isMattermostUserAuthorized, parseAllowedUserIds } from './auth';
import type {
  MattermostChannel,
  MattermostMessageEvent,
  MattermostPost,
  MattermostThreadResponse,
  MattermostUser,
  MattermostWebSocketEnvelope,
} from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.mattermost');
  return cachedLog;
}

const MAX_MESSAGE_LENGTH = 14000;

export class MattermostAdapter implements IPlatformAdapter {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private readonly streamingMode: 'stream' | 'batch';
  private readonly allowedUserIds: string[];
  private readonly channelTypeCache = new Map<string, string>();
  private messageHandler: ((event: MattermostMessageEvent) => Promise<void>) | null = null;
  private socket: WebSocket | null = null;
  private botUserId = '';
  private botUsername = '';
  private nextSeq = 1;
  private stopping = false;

  constructor(baseUrl: string, botToken: string, mode: 'stream' | 'batch' = 'batch') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.botToken = botToken;
    this.streamingMode = mode;
    this.allowedUserIds = parseAllowedUserIds(process.env.MATTERMOST_ALLOWED_USER_IDS);

    if (this.allowedUserIds.length > 0) {
      getLog().info({ userCount: this.allowedUserIds.length }, 'mattermost.whitelist_enabled');
    } else {
      getLog().info('mattermost.whitelist_disabled');
    }

    getLog().info({ mode }, 'mattermost.adapter_initialized');
  }

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    const [channelId, rootId] = conversationId.includes(':')
      ? conversationId.split(':')
      : [conversationId, undefined];

    if (message.length <= MAX_MESSAGE_LENGTH) {
      await this.createPost(channelId, message, rootId);
      return;
    }

    const chunks = splitIntoParagraphChunks(message, MAX_MESSAGE_LENGTH - 500);
    for (const chunk of chunks) {
      await this.createPost(channelId, chunk, rootId);
    }
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'mattermost';
  }

  isThread(event: MattermostMessageEvent): boolean {
    return Boolean(event.root_id && event.root_id !== event.postId);
  }

  getParentConversationId(_event: MattermostMessageEvent): string | null {
    return null;
  }

  async fetchThreadHistory(event: MattermostMessageEvent): Promise<string[]> {
    const rootId = event.root_id;
    if (!rootId) {
      return [];
    }

    try {
      const thread = await this.apiFetch<MattermostThreadResponse>(
        `/api/v4/posts/${rootId}/thread?perPage=100`
      );

      return thread.order
        .map(postId => thread.posts[postId])
        .filter((post): post is MattermostPost => Boolean(post))
        .map(post => {
          const author = post.user_id === this.botUserId ? '[Bot]' : `<@${post.user_id}>`;
          return `${author}: ${post.message ?? ''}`;
        });
    } catch (error) {
      getLog().error({ err: error }, 'mattermost.thread_history_fetch_failed');
      return [];
    }
  }

  getConversationId(event: MattermostMessageEvent): string {
    return `${event.channel}:${event.root_id ?? event.postId}`;
  }

  stripBotMention(text: string): string {
    if (!this.botUsername) {
      return text.trim();
    }

    const escapedUsername = this.botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`^(?:@${escapedUsername}\\s*)+`, 'i'), '').trim();
  }

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  onMessage(handler: (event: MattermostMessageEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const user = await this.apiFetch<MattermostUser>('/api/v4/users/me');
    this.botUserId = user.id;
    this.botUsername = user.username;
    await this.connectWebSocket();
    getLog().info({ botUsername: this.botUsername }, 'mattermost.bot_started');
  }

  stop(): void {
    this.stopping = true;
    this.socket?.close();
    this.socket = null;
    getLog().info('mattermost.bot_stopped');
  }

  private async createPost(channelId: string, message: string, rootId?: string): Promise<void> {
    await this.apiFetch('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify({
        channel_id: channelId,
        message,
        root_id: rootId,
      }),
    });
  }

  private async connectWebSocket(): Promise<void> {
    const socket = new WebSocket(this.getWebSocketUrl());
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            seq: this.nextSeq++,
            action: 'authentication_challenge',
            data: { token: this.botToken },
          })
        );

        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener('message', event => {
        void this.handleSocketMessage(event.data);
      });

      socket.addEventListener('error', event => {
        getLog().error({ event }, 'mattermost.websocket_error');
        if (!settled) {
          settled = true;
          reject(new Error('Mattermost websocket connection failed'));
        }
      });

      socket.addEventListener('close', () => {
        this.socket = null;
        if (!this.stopping) {
          getLog().warn('mattermost.websocket_closed');
        }
      });
    });
  }

  private async handleSocketMessage(rawData: string | ArrayBuffer | Blob): Promise<void> {
    if (!this.messageHandler) {
      return;
    }

    const text = await this.normalizeMessageData(rawData);
    if (!text) {
      return;
    }

    let envelope: MattermostWebSocketEnvelope;
    try {
      envelope = JSON.parse(text) as MattermostWebSocketEnvelope;
    } catch {
      return;
    }

    if (envelope.event !== 'posted' || !envelope.data?.post) {
      return;
    }

    let post: MattermostPost;
    try {
      post = JSON.parse(envelope.data.post) as MattermostPost;
    } catch {
      return;
    }

    if (!post.message || post.user_id === this.botUserId) {
      return;
    }

    if (!isMattermostUserAuthorized(post.user_id, this.allowedUserIds)) {
      const maskedId = `${post.user_id.slice(0, 4)}***`;
      getLog().info({ maskedUserId: maskedId }, 'mattermost.unauthorized_message');
      return;
    }

    const channelType = await this.getChannelType(post.channel_id);
    const isDirectMessage = channelType === 'D';

    if (!isDirectMessage && !this.isBotMentioned(post.message)) {
      return;
    }

    const content = isDirectMessage ? post.message.trim() : this.stripBotMention(post.message);
    if (!content) {
      return;
    }

    await this.messageHandler({
      text: content,
      user: post.user_id,
      channel: post.channel_id,
      postId: post.id,
      root_id: post.root_id || undefined,
    });
  }

  private async getChannelType(channelId: string): Promise<string> {
    const cached = this.channelTypeCache.get(channelId);
    if (cached) {
      return cached;
    }

    const channel = await this.apiFetch<MattermostChannel>(`/api/v4/channels/${channelId}`);
    this.channelTypeCache.set(channelId, channel.type);
    return channel.type;
  }

  private isBotMentioned(text: string): boolean {
    if (!this.botUsername) {
      return false;
    }

    const escapedUsername = this.botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)@${escapedUsername}(\\b|\\s|$)`, 'i').test(text);
  }

  private getWebSocketUrl(): string {
    if (this.baseUrl.startsWith('https://')) {
      return `wss://${this.baseUrl.slice('https://'.length)}/api/v4/websocket`;
    }
    if (this.baseUrl.startsWith('http://')) {
      return `ws://${this.baseUrl.slice('http://'.length)}/api/v4/websocket`;
    }
    return `wss://${this.baseUrl}/api/v4/websocket`;
  }

  private async apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${this.botToken}`);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      throw new Error(`Mattermost API ${path} failed: ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async normalizeMessageData(rawData: string | ArrayBuffer | Blob): Promise<string> {
    if (typeof rawData === 'string') {
      return rawData;
    }

    if (rawData instanceof ArrayBuffer) {
      return new TextDecoder().decode(rawData);
    }

    return await rawData.text();
  }
}
