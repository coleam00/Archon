import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  connectChat,
  ChatStartError,
  type ConnectedChat,
  type ChatRunEvent,
} from '@archon/chat-contract';
import { PluginProtocolError, PluginRemoteError } from '@archon/provider-contract/plugin';
import { buildProviderSubprocessEnv } from '@archon/provider-contract';
import { terminateTree, validateCommand } from '@archon/paths/plugin-process';
import { createLogger } from '@archon/paths';
import { ChatPluginUnavailableError, type ChatConnection } from './platform';
import { windowsJobCommand } from './windows-job';

export type InstalledChatPlugin = Awaited<
  ReturnType<typeof import('@archon/core/platforms/chat-plugins').loadChatPlugins>
>[number];

export interface SupervisorOptions {
  graceMs?: number;
  requestTimeoutMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
}

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
    private readonly onLive: (live: boolean) => void,
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

  async request(
    operation: (connection: ConnectedChat) => Promise<void>,
    acknowledged = true
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new ChatPluginUnavailableError(this.plugin.descriptor.id);
    try {
      await withTimeout(operation(connection), this.options.requestTimeoutMs ?? 30_000);
      if (acknowledged && this.connection === connection) this.sendTimeouts = 0;
    } catch (error) {
      if (error instanceof ChatRequestTimeoutError && this.connection === connection) {
        if (++this.sendTimeouts >= 2) {
          this.connection = undefined;
          this.onLive(false);
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
    this.onLive(false);
    this.wakeBackoff?.();
    await this.dispose?.();
    await this.task;
  }

  private async run(): Promise<void> {
    const { descriptor, argv } = this.plugin;
    const invalid = validateCommand(argv[0]);
    if (invalid) {
      this.log.error({ plugin: descriptor.id, reason: invalid }, 'chat.plugin.failed');
      return;
    }
    let failures = 0;
    while (!this.stopping) {
      let retryable = true;
      const command = process.platform === 'win32' ? windowsJobCommand(argv) : argv;
      const child = spawn(command[0], command.slice(1), {
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
          // POSIX groups survive their leader; Windows descendants belong to the launcher job.
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
            this.options.requestTimeoutMs ?? 30_000
          ),
          spawnFailure,
        ]);
        this.register(connection);
        this.connection = connection;
        await Promise.race([
          withTimeout(connection.start(), this.options.requestTimeoutMs ?? 30_000),
          spawnFailure,
        ]);
        if (!this.stopping) {
          this.sendTimeouts = 0;
          this.onLive(true);
          this.log.info({ plugin: descriptor.id }, 'chat.plugin.started');
          const started = Date.now();
          await Promise.race([connection.closed, ended, spawnFailure]);
          if (Date.now() - started >= 60_000) failures = 0;
        }
      } catch (error) {
        retryable =
          !(error instanceof ChatStartError && !error.retryable) &&
          !(error instanceof PluginProtocolError && error.reason === 'invalid_message');
        this.log.error({ plugin: descriptor.id, retryable }, 'chat.plugin.failed');
      } finally {
        this.connection = undefined;
        this.onLive(false);
        await this.dispose();
        this.dispose = undefined;
        this.log.debug({ plugin: descriptor.id, stderrBytes }, 'chat.plugin.closed');
      }
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
}
