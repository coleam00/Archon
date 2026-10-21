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
  providerFailureClassSchema,
  providerLifecycleEventSchema,
  providerLifecycleWaitedMsSchema,
  type IAgentProvider,
  type CredentialStatus,
  type ProviderChunk,
  type SendQueryOptions,
} from '@archon/provider-contract';
import {
  connectProvider,
  PluginProtocolError,
  PluginProtocolMismatchError,
  PluginRemoteError,
  type ConnectedProvider,
  type ProviderPluginDescriptor,
} from '@archon/provider-contract/plugin';

export type ProcessProviderOrigin = 'source' | 'installed';

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

// detail and evidence hold no text from the plugin's line; cause can, so it stays unread.
function protocolFailure(
  descriptor: ProviderPluginDescriptor,
  log: ReturnType<typeof createLogger>,
  { line, reason, detail, evidence }: PluginProtocolError
): Error {
  log.error(
    {
      provider: descriptor.id,
      line,
      reason,
      detail,
      ...(evidence ? { messageBytes: evidence.bytes, message: evidence.message } : {}),
      pluginVersion: descriptor.version,
    },
    'provider.plugin.protocol_failed'
  );
  const read = evidence ? `message ${evidence.message}, ${String(evidence.bytes)} bytes, ` : '';
  return new Error(
    `Provider plugin ${descriptor.id} protocol failed at line ${String(line)} (${reason}): ${detail} [${read}plugin version ${descriptor.version}]`
  );
}

function startProcess(
  descriptor: ProviderPluginDescriptor,
  argv: readonly [string, ...string[]],
  origin: ProcessProviderOrigin,
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
  // One logger per process, not a module cache: a logger cached by an earlier caller
  // would outlive any test that replaces createLogger to observe these diagnostics.
  const log = createLogger('core.provider-process');
  const env = buildProviderSubprocessEnv(options.execContext?.kind === 'container' ? {} : options);
  const secrets = [
    ...collectCredentialValues(env, options.protectedEnvKeys),
    ...collectCredentialValues(
      options.env ?? {},
      options.protectedEnvKeys,
      Object.values(options.env ?? {}).filter(value => value.length >= 8)
    ),
  ];
  secrets.push(...secrets.map(value => JSON.stringify(value).slice(1, -1)));
  secrets.sort((a, b) => b.length - a.length);
  const redact = (text: string): string => redactCredentialValues(text, secrets);
  const providerLog = createLogger(`provider.${descriptor.id}`);
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
      log.debug(
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
      log.error(
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
  const descriptorMismatch = new Error(
    origin === 'source'
      ? options.env?.WORKFLOW_ID
        ? `Archon's source changed under this run (built-in provider ${descriptor.id}); the run can continue with archon workflow resume ${options.env.WORKFLOW_ID}`
        : `The Archon process is running older code than the checkout (built-in provider ${descriptor.id}); restart the Archon process`
      : `Provider plugin ${descriptor.id} changed since install; run archon plugin update for this plugin`
  );
  return {
    async connect(): Promise<ConnectedProvider> {
      const connection = await connectProvider(
        {
          readable: Readable.toWeb(child.stdout),
          writable: Writable.toWeb(child.stdin),
        },
        {
          onLog(record): void {
            // Plugin text and arbitrary JSON can encode message excerpts or credentials.
            // Only the severity, a failure class and a lifecycle event from the contract's
            // closed enums, and a lifecycle event's numeric `waitedMs`, cross this boundary.
            // An open plugin-chosen token would let a credential-shaped word through, so no
            // other plugin field is forwarded. A record with neither enum value would reach
            // the log as severity alone, which no operator can act on, so it is dropped.
            const failureClass = providerFailureClassSchema.safeParse(record.bindings.failureClass);
            const lifecycle = providerLifecycleEventSchema.safeParse(record.bindings.lifecycle);
            if (!failureClass.success && !lifecycle.success) return;
            const waitedMs = providerLifecycleWaitedMsSchema.safeParse(record.bindings.waitedMs);
            providerLog[record.level](
              {
                ...(failureClass.success ? { failureClass: failureClass.data } : {}),
                ...(lifecycle.success ? { lifecycle: lifecycle.data } : {}),
                ...(lifecycle.success && waitedMs.success ? { waitedMs: waitedMs.data } : {}),
              },
              'provider.plugin.log'
            );
          },
        }
      );
      if (!isDeepStrictEqual(connection.descriptor, descriptor)) {
        throw descriptorMismatch;
      }
      return connection;
    },
    async failure(error: unknown): Promise<Error> {
      // This host-authored diagnostic includes the public run ID that env redaction would hide.
      if (error === descriptorMismatch) return descriptorMismatch;
      // EOF does not imply process exit: a provider can close stdout and stay alive.
      // A protocol mismatch closed the host's side, so the plugin ends like on EOF; waiting
      // for it keeps the exit from racing termination.
      if (
        (error instanceof PluginProtocolError && error.reason === 'closed') ||
        error instanceof PluginProtocolMismatchError ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        spawnError
      ) {
        if (child.exitCode === null && child.signalCode === null && !spawnError)
          await dispose(true);
        await closed;
      }
      if (spawnError) return spawnError;
      // Carries only validated protocol values; the exit report would lose both versions.
      if (error instanceof PluginProtocolMismatchError) return error;
      // A plugin that exits after an invalid line still failed on that line; its exit
      // report would drop the protocol evidence.
      if (error instanceof PluginProtocolError && error.reason === 'invalid_message')
        return protocolFailure(descriptor, log, error);
      if (exited)
        return new ProviderPluginExitedError(
          descriptor.id,
          child.exitCode,
          child.signalCode,
          evidence()
        );
      if (error instanceof PluginRemoteError)
        return new PluginRemoteError(
          error.code,
          `Provider plugin ${descriptor.id} request failed (RPC ${String(error.code)})`
        );
      if (error instanceof PluginProtocolError) return protocolFailure(descriptor, log, error);
      return new Error(redact(error instanceof Error ? error.message : String(error)));
    },
    dispose,
  };
}

export class ProcessAgentProvider implements IAgentProvider {
  constructor(
    private readonly descriptor: ProviderPluginDescriptor,
    private readonly argv: readonly [string, ...string[]],
    private readonly origin: ProcessProviderOrigin
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
    const process = startProcess(
      this.descriptor,
      this.argv,
      this.origin,
      options,
      options.abortSignal
    );
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
    const process = startProcess(
      this.descriptor,
      this.argv,
      this.origin,
      { env: request.env, execContext: request.execContext },
      request.signal
    );
    try {
      return await (await process.connect()).checkCredential(request);
    } catch (error) {
      request.signal.throwIfAborted();
      throw await process.failure(error);
    } finally {
      await process.dispose(true);
    }
  }

  async diagnose(
    request: Parameters<NonNullable<IAgentProvider['diagnose']>>[0]
  ): ReturnType<NonNullable<IAgentProvider['diagnose']>> {
    const process = startProcess(this.descriptor, this.argv, this.origin, {}, request.signal);
    try {
      return await (await process.connect()).diagnose(request);
    } catch (error) {
      request.signal.throwIfAborted();
      throw await process.failure(error);
    } finally {
      await process.dispose(true);
    }
  }

  async listModels(
    request: Parameters<NonNullable<IAgentProvider['listModels']>>[0]
  ): ReturnType<NonNullable<IAgentProvider['listModels']>> {
    const process = startProcess(this.descriptor, this.argv, this.origin, {}, request.signal);
    try {
      return await (await process.connect()).listModels(request);
    } catch (error) {
      throw await process.failure(error);
    } finally {
      await process.dispose(true);
    }
  }

  async resolveCredentialModel(
    request: Parameters<NonNullable<IAgentProvider['resolveCredentialModel']>>[0]
  ): Promise<string | undefined> {
    const process = startProcess(this.descriptor, this.argv, this.origin, {});
    try {
      return await (await process.connect()).resolveCredentialModel(request);
    } catch (error) {
      throw await process.failure(error);
    } finally {
      await process.dispose(true);
    }
  }
}
