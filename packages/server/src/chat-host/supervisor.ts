import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  connectChat,
  ChatStartError,
  type ConnectedChat,
  type ChatRunEvent,
} from '@archon/chat-contract';
import {
  PluginProtocolError,
  PluginProtocolMismatchError,
  PluginRemoteError,
} from '@archon/provider-contract/plugin';
import { buildProviderSubprocessEnv } from '@archon/provider-contract';
import { terminateTree, validateCommand } from '@archon/paths/plugin-process';
import { createLogger } from '@archon/paths';
import { ChatPluginUnavailableError, type ChatConnection } from './platform';

export type InstalledChatPlugin = Awaited<
  ReturnType<typeof import('@archon/core/platforms/chat-plugins').loadChatPlugins>
>[number];

export interface SupervisorOptions {
  graceMs?: number;
  requestTimeoutMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
}

/** `failed` is terminal: a non-retryable start or an invalid command is never restarted. */
export type ChatPluginState = 'starting' | 'live' | 'failed' | 'stopped';

const BOOTSTRAP_TIMEOUT_MS = 30_000;

class ChatRequestTimeoutError extends Error {}

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ChatRequestTimeoutError());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ChatSupervisor implements ChatConnection {
  private connection?: ConnectedChat;
  private task?: Promise<void>;
  private stopping = false;
  private dispose?: () => Promise<void>;
  private wakeBackoff?: () => void;
  private sendTimeouts = 0;
  private readonly log = createLogger('server.chat-host');

  constructor(
    readonly plugin: InstalledChatPlugin,
    private readonly register: (connection: ConnectedChat) => void,
    private readonly onState: (state: ChatPluginState) => void,
    private readonly options: SupervisorOptions = {}
  ) {}

  start(): void {
    if (!this.task) {
      this.task = this.run();
      void this.task.catch(() => {
        this.log.error({ plugin: this.plugin.descriptor.id }, 'chat.plugin.supervision_failed');
      });
    }
  }

  async request<T>(
    operation: (connection: ConnectedChat) => Promise<T>,
    acknowledged = true
  ): Promise<T> {
    const connection = this.connection;
    if (!connection) throw new ChatPluginUnavailableError(this.plugin.descriptor.id);
    try {
      const result = await withTimeout(
        operation(connection),
        this.options.requestTimeoutMs ?? 30_000
      );
      if (acknowledged && this.connection === connection) this.sendTimeouts = 0;
      return result;
    } catch (error) {
      if (error instanceof ChatRequestTimeoutError && this.connection === connection) {
        if (++this.sendTimeouts >= 2) {
          this.connection = undefined;
          this.onState('starting');
          await this.dispose?.();
        }
      }
      this.log.warn(
        {
          plugin: this.plugin.descriptor.id,
          rpcCode: error instanceof PluginRemoteError ? error.code : undefined,
          timeout: error instanceof ChatRequestTimeoutError,
        },
        'chat.plugin.request_failed'
      );
      // Remote errors may contain credentials or arbitrary excerpts of user messages.
      throw new ChatPluginUnavailableError(this.plugin.descriptor.id);
    }
  }

  runEvent(event: ChatRunEvent): Promise<void> {
    // Notifications have no acknowledgement and cannot prove a hung RPC handler recovered.
    return this.request(connection => connection.runEvent(event), false);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connection = undefined;
    this.onState('stopped');
    this.wakeBackoff?.();
    await this.dispose?.();
    await this.task;
  }

  private async run(): Promise<void> {
    const { descriptor, argv } = this.plugin;
    const invalid = validateCommand(argv[0]);
    if (invalid) {
      this.log.error({ plugin: descriptor.id, reason: invalid }, 'chat.plugin.failed');
      this.onState('failed');
      return;
    }
    this.onState('starting');
    let failures = 0;
    while (!this.stopping) {
      const { retryable, sustained } = await this.runAttempt();
      if (sustained) failures = 0;
      if (this.stopping || !retryable) return;
      const delayMs = Math.min(
        (this.options.backoffMs ?? 1_000) * 2 ** Math.min(failures++, 16),
        this.options.maxBackoffMs ?? 30_000
      );
      this.log.info({ plugin: descriptor.id, delayMs }, 'chat.plugin.restart_scheduled');
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delayMs);
        this.wakeBackoff = (): void => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeBackoff = undefined;
    }
  }

  private async runAttempt(): Promise<{ retryable: boolean; sustained: boolean }> {
    const { descriptor, argv } = this.plugin;
    let retryable = true;
    let sustained = false;
    const child = spawn(argv[0], argv.slice(1), {
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: buildProviderSubprocessEnv({}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Bun may clear child.pid on exit; retain the launched process group identity.
    const pid = child.pid;
    let exited = false;
    let stderrBytes = 0;
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.byteLength;
    });
    child.stdin.on('error', () => {
      /* RPC reports writer failure. */
    });
    const spawnFailure = new Promise<never>((_, reject) => {
      child.once('error', () => {
        reject(new ChatPluginUnavailableError(descriptor.id));
      });
    });
    const closed = new Promise<void>(resolve =>
      child.once('close', () => {
        resolve();
      })
    );
    const ended = new Promise<void>(resolve =>
      child.once('exit', () => {
        exited = true;
        resolve();
      })
    );
    let disposal: Promise<void> | undefined;
    this.dispose = (): Promise<void> =>
      (disposal ??= (async (): Promise<void> => {
        child.stdin.end();
        await Promise.race([
          closed,
          new Promise<void>(resolve => {
            const timer = setTimeout(resolve, this.options.graceMs ?? 10_000);
            void closed.then(() => {
              clearTimeout(timer);
            });
          }),
        ]);
        try {
          // POSIX groups survive their leader. On Windows, descendants of a root that
          // already exited are not reaped, the same gap provider plugins accept.
          if (pid !== undefined && (!exited || process.platform !== 'win32'))
            await terminateTree(pid);
        } finally {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
        await closed;
      })());
    try {
      const connection = await Promise.race([
        withTimeout(
          connectChat(
            {
              readable: Readable.toWeb(child.stdout),
              writable: Writable.toWeb(child.stdin),
            },
            descriptor
          ),
          BOOTSTRAP_TIMEOUT_MS
        ),
        spawnFailure,
      ]);
      this.register(connection);
      this.connection = connection;
      await Promise.race([withTimeout(connection.start(), BOOTSTRAP_TIMEOUT_MS), spawnFailure]);
      if (!this.stopping) {
        this.sendTimeouts = 0;
        this.onState('live');
        this.log.info({ plugin: descriptor.id }, 'chat.plugin.started');
        const started = Date.now();
        await Promise.race([connection.closed, ended, spawnFailure]);
        if (Date.now() - started >= 60_000) sustained = true;
      }
    } catch (error) {
      retryable =
        !(error instanceof ChatStartError && !error.retryable) &&
        !(error instanceof PluginProtocolError && error.reason === 'invalid_message');
      this.log.error(
        {
          plugin: descriptor.id,
          retryable,
          ...(error instanceof PluginProtocolMismatchError
            ? { hostProtocol: error.hostProtocol, pluginProtocol: error.pluginProtocol }
            : {}),
        },
        'chat.plugin.failed'
      );
    } finally {
      this.connection = undefined;
      this.onState(this.stopping ? 'stopped' : retryable ? 'starting' : 'failed');
      await this.dispose();
      this.dispose = undefined;
      this.log.debug({ plugin: descriptor.id, stderrBytes }, 'chat.plugin.closed');
    }
    return { retryable, sustained };
  }
}
