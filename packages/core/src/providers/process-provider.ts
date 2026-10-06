import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { terminateTree, validateCommand } from '@archon/paths/plugin-process';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { createLogger } from '@archon/paths';
import {
  buildProviderSubprocessEnv,
  type IAgentProvider,
  type CredentialStatus,
  type ProviderChunk,
  type SendQueryOptions,
} from '@archon/provider-contract';
import {
  connectProvider,
  ProviderPluginProtocolError,
  ProviderPluginRemoteError,
  type ConnectedProvider,
  type ProviderPluginDescriptor,
} from '@archon/provider-contract/plugin';

let log: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (log ??= createLogger('core.provider-process'));
}

const EXIT_GRACE_MS = 10_000;

export class ProviderPluginExitedError extends Error {
  constructor(
    public readonly provider: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stderr: string
  ) {
    super(
      `Provider plugin ${provider} exited (${signal ?? String(exitCode)}) before completing: ${stderr}`
    );
    this.name = 'ProviderPluginExitedError';
  }
}

function startProcess(
  descriptor: ProviderPluginDescriptor,
  argv: readonly [string, ...string[]],
  options: Pick<SendQueryOptions, 'env' | 'execContext' | 'protectedEnvKeys'>,
  signal?: AbortSignal
): {
  connect(): Promise<ConnectedProvider>;
  failure(error: unknown): Promise<Error>;
  dispose(graceful: boolean): Promise<void>;
} {
  signal?.throwIfAborted();
  const invalid = validateCommand(argv[0]);
  if (invalid) throw new Error(`Provider plugin ${descriptor.id}: ${invalid}`);
  const env = buildProviderSubprocessEnv(options);
  const secrets = collectCredentialValues(
    env,
    options.protectedEnvKeys,
    Object.values(options.env ?? {}).filter(value => value.length >= 8)
  );
  secrets.push(...secrets.map(value => JSON.stringify(value).slice(1, -1)));
  secrets.sort((a, b) => b.length - a.length);
  const redact = (text: string): string => redactCredentialValues(text, secrets);
  const child = spawn(argv[0], argv.slice(1), {
    detached: process.platform !== 'win32',
    windowsHide: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Bun can reset child.pid after exit; termination must use the PID we launched.
  const pid = child.pid;
  let stderrBytes = 0;
  let exited = false;
  let spawnError: Error | undefined;
  let killing: Promise<void> | undefined;
  // Provider stderr can echo arbitrary excerpts of messages or credentials. Only its
  // byte count is safe diagnostic evidence; exact-value redaction cannot protect prose.
  child.stderr.on('data', (data: Buffer) => {
    stderrBytes += data.byteLength;
  });
  const evidence = (): string => (stderrBytes ? '[REDACTED] provider stderr withheld' : '');
  child.on('error', error => {
    spawnError = new Error(redact(error.message));
  });
  child.stdin.on('error', () => {
    /* The RPC writer reports pipe failures to its caller. */
  });
  const closed = new Promise<void>(resolve => {
    child.once('close', () => {
      exited = true;
      getLog().debug(
        {
          provider: descriptor.id,
          exitCode: child.exitCode,
          signal: child.signalCode,
          stderrBytes,
        },
        'provider.plugin.closed'
      );
      resolve();
    });
  });
  const kill = (): Promise<void> => {
    killing ??= (async (): Promise<void> => {
      try {
        if (pid !== undefined && (!exited || process.platform !== 'win32'))
          await terminateTree(pid);
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    })();
    return killing;
  };
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const forceStop = (): void => {
    void kill().catch(error => {
      getLog().error(
        {
          provider: descriptor.id,
          error: redact(error instanceof Error ? error.message : String(error)),
        },
        'provider.plugin.termination_failed'
      );
    });
  };
  let disposing: Promise<void> | undefined;
  const abort = (): void => {
    if (disposing) forceStop();
    else cancelTimer ??= setTimeout(forceStop, EXIT_GRACE_MS);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  function dispose(graceful: boolean): Promise<void> {
    disposing ??= (async (): Promise<void> => {
      if (graceful && !signal?.aborted) {
        child.stdin.end();
        const timer = setTimeout(forceStop, EXIT_GRACE_MS);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      } else await kill();
      if (signal?.aborted) await kill();
      await killing;
      await closed;
      signal?.removeEventListener('abort', abort);
      if (cancelTimer) clearTimeout(cancelTimer);
    })();
    return disposing;
  }
  return {
    async connect(): Promise<ConnectedProvider> {
      const connection = await connectProvider({
        readable: Readable.toWeb(child.stdout),
        writable: Writable.toWeb(child.stdin),
      });
      if (!isDeepStrictEqual(connection.descriptor, descriptor)) {
        throw new Error(
          `Provider plugin ${descriptor.id} changed since install; run archon plugin update for this plugin`
        );
      }
      return connection;
    },
    async failure(error: unknown): Promise<Error> {
      // EOF does not imply process exit: a provider can close stdout and stay alive.
      if (
        (error instanceof ProviderPluginProtocolError && error.reason === 'closed') ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        spawnError
      ) {
        if (child.exitCode === null && child.signalCode === null && !spawnError)
          await dispose(true);
        await closed;
      }
      if (spawnError) return spawnError;
      if (exited)
        return new ProviderPluginExitedError(
          descriptor.id,
          child.exitCode,
          child.signalCode,
          evidence()
        );
      if (error instanceof ProviderPluginRemoteError)
        return new Error(
          `Provider plugin ${descriptor.id} request failed (RPC ${String(error.code)})`
        );
      if (error instanceof ProviderPluginProtocolError)
        return new Error(
          `Provider plugin ${descriptor.id} protocol failed at line ${String(error.line)} (${error.reason})`
        );
      return new Error(redact(error instanceof Error ? error.message : String(error)));
    },
    dispose,
  };
}

export class ProcessAgentProvider implements IAgentProvider {
  constructor(
    private readonly descriptor: ProviderPluginDescriptor,
    private readonly argv: readonly [string, ...string[]]
  ) {}

  getType(): string {
    return this.descriptor.id;
  }
  getCapabilities(): ProviderPluginDescriptor['capabilities'] {
    return this.descriptor.capabilities;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options: SendQueryOptions = {}
  ): AsyncGenerator<ProviderChunk> {
    if (options.abortSignal?.aborted) return;
    const process = startProcess(this.descriptor, this.argv, options, options.abortSignal);
    let settled = false;
    try {
      const connection = await process.connect();
      for await (const chunk of connection.sendQuery(prompt, cwd, resumeSessionId, options)) {
        if (options.abortSignal?.aborted) return;
        if (chunk.type === 'settled') {
          settled = true;
          await process.dispose(true);
          if (options.abortSignal?.aborted) return;
        }
        yield chunk;
      }
    } catch (error) {
      if (!options.abortSignal?.aborted) throw await process.failure(error);
    } finally {
      await process.dispose(settled);
    }
  }

  async checkCredential(
    request: Parameters<IAgentProvider['checkCredential']>[0]
  ): Promise<CredentialStatus> {
    const process = startProcess(this.descriptor, this.argv, { env: request.env }, request.signal);
    try {
      return await (await process.connect()).checkCredential(request);
    } catch (error) {
      request.signal.throwIfAborted();
      throw await process.failure(error);
    } finally {
      await process.dispose(true);
    }
  }

  async resolveCredentialModel(
    request: Parameters<NonNullable<IAgentProvider['resolveCredentialModel']>>[0]
  ): Promise<string | undefined> {
    const process = startProcess(this.descriptor, this.argv, {});
    try {
      return await (await process.connect()).resolveCredentialModel(request);
    } catch (error) {
      throw await process.failure(error);
    } finally {
      await process.dispose(true);
    }
  }
}
