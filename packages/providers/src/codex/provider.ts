/**
 * Codex provider: one Codex turn per `sendQuery` (two on a model listed in
 * `toolFreeStructuredOutputModels`), driven over the `codex app-server`
 * JSON-RPC protocol so a failed turn reports a typed `codexErrorInfo`.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse';
import type { CredentialStatus, ProviderDiagnostics } from '@archon/provider-contract';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import {
  mergeTokenUsage,
  type IAgentProvider,
  type SendQueryOptions,
  type MessageChunk,
  type ResultChunk,
  type ProviderCapabilities,
  type TokenUsage,
} from '../types';
import { sessionPreview } from '@archon/provider-contract';
import { failureResult } from '../shared/failure';
import { diagnoseBinary } from '../shared/binary-diagnostics';
import { readCodexSetupEnv, formatCodexSetupDeprecation } from './setup-env';
import { parseCodexConfig, type CodexProviderDefaults } from './config';
import { buildCodexNativeTools } from './native-tools';
import { CODEX_CAPABILITIES } from './capabilities';
import { CODEX_CREDENTIAL_ENV } from './credential-env';
import { resolveCodexBinaryWithSource } from './binary-resolver';
import { BUNDLED_VERSION, createLogger } from '@archon/paths';
import { closeOpenToolCalls } from '../shared/tool-calls';
import {
  AppServerConnection,
  ConnectionClosedError,
  JsonRpcError,
  settlesWithin,
  type Spawner,
} from './app-server';
import { failureClassOfStop, withModelAccessAdvice } from './turn-error';
import { codexLaunch, codexLogin, type CodexLogin } from './login';
import {
  buildEffectivePrompt,
  buildOutputSchema,
  buildThreadConfig,
  isWorkflowNode,
  loadNodeMcpServers,
  resolveModelReasoningEffort,
  splitsStructuredOutput,
  TOOL_FREE_THREAD_CONFIG,
  type CodexConfig,
} from './turn-params';
import { streamTurn, type TurnRequest } from './stream';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

/**
 * The `account/read` fields the login check decides on. The account's own fields (type,
 * plan, email) are left unvalidated, so a Codex that adds an account type, a plan or a
 * field still reads as logged in.
 */
const accountResponseSchema = z.object({
  account: z.object({}).nullable(),
  requiresOpenaiAuth: z.boolean(),
}) satisfies z.ZodType<Pick<GetAccountResponse, 'requiresOpenaiAuth'>>;

const TOOL_SESSION_MARKER = 'archon-codex-tools';
const codexSessionId = {
  encode(threadId: string, catalogId: string | undefined): string {
    return catalogId ? `${threadId}:${TOOL_SESSION_MARKER}:${catalogId}` : threadId;
  },
  decode(sessionId: string, catalogId: string | undefined): string {
    const [threadId, marker, savedCatalog, ...rest] = sessionId.split(':');
    const marked = marker === TOOL_SESSION_MARKER;
    if (
      (catalogId || marked) &&
      (!marked || savedCatalog !== catalogId || !threadId || rest.length)
    ) {
      throw new Error(
        'This Codex chat has an older or different tool catalog. Start a new chat to use the current Archon tools.'
      );
    }
    return marked ? threadId : sessionId;
  },
};

/**
 * How long the app-server gets to answer a cancel's interrupt, then to exit after stdin
 * closes, then again after SIGTERM.
 */
const SHUTDOWN_GRACE_MS = 3000;

/** The input of the tool-free turn that gives a split node its structured answer. */
const FINAL_ANSWER_INSTRUCTION =
  'Give your final answer now, based on the work above. ' +
  'If you could not complete the task, say so and why in the answer.';

/** The live app-server of one `sendQuery`, and the ids a cancel interrupts. */
interface CodexRun {
  connection: AppServerConnection | undefined;
  threadId: string | undefined;
  turnId: string | undefined;
}

type NativeTools = ReturnType<typeof buildCodexNativeTools>;

/**
 * Codex persists the catalog only at thread/start and cannot report or replace it on
 * resume. Carry its fingerprint in Archon's opaque session id, across host restarts.
 */
function toolCatalogId(tools: NativeTools): string | undefined {
  if (!tools.specs.length) return undefined;
  return createHash('sha256')
    .update(JSON.stringify([...tools.specs].sort((a, b) => a.name.localeCompare(b.name))))
    .digest('hex');
}

/**
 * Declared workflow plugins, or an empty list for titles. Undefined for direct chat,
 * which keeps the user's setup.
 */
function nodePluginsOf(
  requestOptions: SendQueryOptions | undefined,
  titleRequest: boolean
): readonly string[] | undefined {
  if (titleRequest) return [];
  return isWorkflowNode(requestOptions) ? (requestOptions?.nodeConfig?.plugins ?? []) : undefined;
}

/** The node's MCP servers for the thread config; yields their load warnings. */
async function* nodeMcpServers(
  requestOptions: SendQueryOptions | undefined,
  cwd: string,
  titleRequest: boolean
): AsyncGenerator<MessageChunk, CodexConfig | undefined> {
  const mcpPath = requestOptions?.nodeConfig?.mcp;
  if (titleRequest || !mcpPath) return undefined;
  const { mcpServers, warnings } = await loadNodeMcpServers(mcpPath, cwd, requestOptions.env);
  for (const warning of warnings) {
    yield { type: 'warning', ...warning };
  }
  return mcpServers;
}

function appServerArgs(login: CodexLogin | undefined, nodePlugins: readonly string[] | undefined) {
  return [
    // An Archon-supplied login stays out of the user's CODEX_HOME; without one Codex
    // uses the user's own login there.
    ...(login ? ['-c', 'cli_auth_credentials_store="ephemeral"'] : []),
    // A user who turned plugins off globally gets an empty `plugin/installed`, so a
    // node that names plugins could not find them. This process serves only this
    // node's thread, and the thread config switches off every plugin it does not name.
    ...(nodePlugins?.length ? ['-c', 'features.plugins=true'] : []),
  ];
}

/** A turn's result as `sendQuery` reports it, with the thread id as Archon's session id. */
function reportResult(
  result: ResultChunk,
  abortSignal: AbortSignal | undefined,
  catalogId: string | undefined
): void {
  // An interrupted turn completes before its process ends; a cancel is not a result.
  if (abortSignal?.aborted) throw new Error('Query aborted');
  if (result.sessionId) result.sessionId = codexSessionId.encode(result.sessionId, catalogId);
}

/** The failure result for an error that ended the turn before it reported one. */
function stopFailureResult(
  error: unknown,
  model: string | undefined,
  hasNativeTools: boolean,
  session: { threadId: string | undefined; catalogId: string | undefined }
): ResultChunk {
  const failureClass = failureClassOfStop(error);
  const subtype = error instanceof JsonRpcError ? 'codex_request_failed' : 'codex_query_failed';
  const actionAdvice =
    error instanceof ConnectionClosedError && hasNativeTools
      ? ' An accepted Archon action may have completed. Inspect run and project state before retrying.'
      : '';
  const result = failureResult(
    failureClass,
    subtype,
    withModelAccessAdvice(
      error instanceof ConnectionClosedError ? error.evidence : (error as Error).message,
      model,
      (error as Error).message
    ) + actionAdvice
  );
  if (session.threadId) {
    result.sessionId = codexSessionId.encode(session.threadId, session.catalogId);
  }
  return result;
}

// ─── Codex Provider ──────────────────────────────────────────────────────

export class CodexProvider implements IAgentProvider {
  async diagnose(
    request: Parameters<NonNullable<IAgentProvider['diagnose']>>[0]
  ): Promise<ProviderDiagnostics> {
    const config = parseCodexConfig(request.assistantConfig ?? {});
    const diagnostics = await diagnoseBinary(
      'codex-binary',
      'Codex binary',
      () => resolveCodexBinaryWithSource(config.codexBinaryPath),
      request.signal
    );
    const { deprecated } = readCodexSetupEnv(process.env);
    diagnostics.checks.push({
      id: 'codex-setup-env',
      label: 'Codex setup environment',
      status: deprecated.length ? 'warn' : 'ok',
      message: deprecated.length
        ? formatCodexSetupDeprecation(deprecated)
        : 'No deprecated Codex setup variables',
    });
    return diagnostics;
  }

  /**
   * @param spawner starts the app-server process; tests pass a fake.
   * @param shutdownGraceMs each cancel and shutdown wait; tests shorten it.
   */
  constructor(
    private readonly spawner?: Spawner,
    private readonly shutdownGraceMs = SHUTDOWN_GRACE_MS
  ) {}

  async checkCredential(
    request: Parameters<IAgentProvider['checkCredential']>[0]
  ): Promise<CredentialStatus> {
    const { signal } = request;
    const { env, resolveBinary } = codexLaunch(request.assistantConfig, request.env);
    let connection: AppServerConnection | undefined;
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      if (codexLogin(env)) return { state: 'usable', source: 'native' };
      const binary = await resolveBinary();
      signal.throwIfAborted();
      connection = AppServerConnection.start(binary, [], env, this.spawner);
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([
        aborted,
        connection.request('initialize', {
          clientInfo: { name: 'archon', title: 'Archon', version: BUNDLED_VERSION },
          capabilities: null,
        }),
      ]);
      connection.notify('initialized');
      const response = await Promise.race([
        aborted,
        // Ask for a refresh so a revoked sign-in reads as no account. A turn never sends
        // account/read, so this refresh is the check's own.
        connection.request('account/read', { refreshToken: true }),
      ]);
      signal.throwIfAborted();
      const validated = accountResponseSchema.safeParse(response);
      if (!validated.success) {
        return {
          state: 'check_failed',
          source: 'native',
          evidence: 'Codex account/read returned an invalid protocol response.',
        };
      }
      const { account, requiresOpenaiAuth } = validated.data;
      if (account !== null) return { state: 'usable', source: 'native' };
      // A model provider configured in Codex that needs no OpenAI login authenticates on its
      // own terms, which account/read does not report.
      if (!requiresOpenaiAuth) return { state: 'not_checked', source: 'native' };
      return {
        state: 'unusable',
        source: 'native',
        evidence:
          'Codex reports no usable login: it is not signed in, or its sign-in could not be refreshed. Run `codex login`.',
      };
    } catch (error) {
      const reason: unknown = signal.aborted ? signal.reason : error;
      return {
        state: 'check_failed',
        source: 'native',
        evidence: redactCredentialValues(
          reason instanceof ConnectionClosedError
            ? reason.evidence
            : reason instanceof Error
              ? reason.message
              : String(reason),
          collectCredentialValues(env)
        ),
      };
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      await connection?.shutdown(this.shutdownGraceMs);
    }
  }

  getCapabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  /**
   * One call is one Codex turn on its own app-server process. A failure ends in a
   * `result` carrying a typed `failure`, and the engine decides whether to try again.
   * Observed work must drain before `settled`; lost observation never settles.
   *
   * On a model listed in `toolFreeStructuredOutputModels`, a call with an output schema is
   * two turns on one thread: the tool turn without the schema, then, on a second process
   * that resumes the thread with every tool off, a turn with the schema. The tool turn's
   * success result is held back; the final turn's result is the call's only one.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const abortSignal = requestOptions?.abortSignal;
    const run: CodexRun = { connection: undefined, threadId: undefined, turnId: undefined };
    const call: CallState = {
      resultReported: false,
      observationLost: false,
      toolTurnResult: undefined,
    };
    const onAbort = (): void => {
      this.cancel(run);
    };

    const launch = codexLaunch(
      requestOptions?.assistantConfig,
      requestOptions?.env,
      requestOptions?.userCredentialEnvKeys
    );
    const model = requestOptions?.model ?? launch.config.model;
    const titleRequest = requestOptions?.purpose === 'title-generation';
    const nativeTools = titleRequest ? undefined : requestOptions?.nativeTools;
    let catalogId: string | undefined;
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (abortSignal?.aborted) {
        throw new Error('Query aborted');
      }
      const tools = buildCodexNativeTools(nativeTools ?? []);
      catalogId = toolCatalogId(tools);
      const resumeThreadId = resumeSessionId
        ? codexSessionId.decode(resumeSessionId, catalogId)
        : resumeSessionId;
      const mcpServers = yield* nodeMcpServers(requestOptions, cwd, titleRequest);

      const login = codexLogin(launch.env);
      const binary = await launch.resolveBinary();
      const nodePlugins = nodePluginsOf(requestOptions, titleRequest);
      const { request, finalTurnParams } = turnRequestOf(prompt, cwd, requestOptions, {
        tools,
        login,
        resumeThreadId,
        model,
        titleRequest,
        nodePlugins,
        threadConfig: buildThreadConfig(launch.config, mcpServers, nodePlugins !== undefined),
        modelReasoningEffort: launch.config.modelReasoningEffort,
        splitsStructuredOutput: !titleRequest && splitsStructuredOutput(launch.config, model),
        run,
      });
      const startAppServer = (plugins: readonly string[] | undefined): AppServerConnection =>
        AppServerConnection.start(
          binary,
          appServerArgs(login, plugins),
          launch.env,
          this.spawner,
          requestOptions?.protectedEnvKeys
        );
      run.connection = startAppServer(nodePlugins);
      // An abort while the setup above awaited found no process to stop.
      if (abortSignal?.aborted) throw new Error('Query aborted');

      yield* reportedTurn(streamTurn({ ...request, connection: run.connection }), call, {
        holdsSuccess: finalTurnParams !== undefined,
        catalogId,
        abortSignal,
      });
      if (call.toolTurnResult && finalTurnParams) {
        const finalRequest = finalTurnRequestOf(request, finalTurnParams, launch.config);
        yield* this.finalTurn(run, finalRequest, startAppServer, call, catalogId);
      }
    } catch (error) {
      await run.connection?.finishToolCalls();
      if (abortSignal?.aborted === true) {
        throw new Error('Query aborted');
      }
      call.observationLost ||= error instanceof ConnectionClosedError || call.resultReported;
      getLog().error({ err: error, resultReported: call.resultReported }, 'query_error');
      if (!call.resultReported) {
        const result = stopFailureResult(error, model, Boolean(nativeTools?.length), {
          threadId: run.threadId,
          catalogId,
        });
        yield withToolTurnOf(result, call.toolTurnResult);
      }
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      if (run.connection && !(await this.shutDown(run.connection))) call.observationLost = true;
    }
    if (!call.observationLost) yield { type: 'settled' };
  }

  /**
   * The tool-free turn of a split call, on a second process that resumes the tool turn's
   * thread. The tool turn's process ends first.
   */
  private async *finalTurn(
    run: CodexRun,
    request: Omit<TurnRequest, 'connection' | 'resumeSessionId'>,
    startAppServer: (plugins: readonly string[]) => AppServerConnection,
    call: CallState,
    catalogId: string | undefined
  ): AsyncGenerator<MessageChunk> {
    if (run.connection && !(await this.shutDown(run.connection))) call.observationLost = true;
    run.connection = startAppServer([]);
    if (request.abortSignal?.aborted) throw new Error('Query aborted');
    const stream = streamTurn({
      ...request,
      connection: run.connection,
      resumeSessionId: run.threadId,
    });
    yield* reportedTurn(stream, call, {
      holdsSuccess: false,
      catalogId,
      abortSignal: request.abortSignal,
    });
  }

  /**
   * Cancel: interrupt the turn so Codex stops its command, then end the process. The
   * stream sees the process end and `sendQuery` throws `Query aborted`. A Codex that does
   * not answer the interrupt within the grace period is shut down anyway.
   */
  private cancel(run: CodexRun): void {
    const open = run.connection;
    if (!open) return;
    const { threadId, turnId } = run;
    const interrupt =
      threadId && turnId
        ? open.request('turn/interrupt', { threadId, turnId }).catch((error: unknown) => {
            getLog().debug({ err: error }, 'codex.interrupt_failed');
          })
        : Promise.resolve();
    void settlesWithin(interrupt, this.shutdownGraceMs).then(answered => {
      if (!answered) {
        getLog().warn(
          { sessionIdPreview: threadId && sessionPreview(threadId), turnId },
          'codex.interrupt_unanswered'
        );
      }
      return open.shutdown(this.shutdownGraceMs);
    });
  }

  /** Finish tool calls and stop the process; false when it did not exit cleanly. */
  private async shutDown(connection: AppServerConnection): Promise<boolean> {
    await connection.finishToolCalls();
    const end = await connection.shutdown(this.shutdownGraceMs);
    if (end?.kind === 'exited' && end.code === 0 && end.signal === null) return true;
    if (end) getLog().error({ err: connection.closedError(end) }, 'codex.app_server_abnormal_exit');
    return false;
  }

  getType(): string {
    return 'codex';
  }
}

/** What `turnRequestOf` reads beyond the request options. */
interface TurnInputs {
  tools: NativeTools;
  login: CodexLogin | undefined;
  resumeThreadId: string | undefined;
  model: string | undefined;
  titleRequest: boolean;
  nodePlugins: readonly string[] | undefined;
  threadConfig: CodexConfig;
  modelReasoningEffort: Parameters<typeof resolveModelReasoningEffort>[1];
  /** The model's route cannot take tools and an output schema in one request. */
  splitsStructuredOutput: boolean;
  run: CodexRun;
}

/** What one `sendQuery` has observed so far, shared by its turns and its error path. */
interface CallState {
  resultReported: boolean;
  /** A process ended abnormally, so its work may still be running unobserved. */
  observationLost: boolean;
  /** The held-back success of a split call's tool turn. */
  toolTurnResult: ResultChunk | undefined;
}

/**
 * Pass one turn's chunks through and report its result. A turn that `holdsSuccess` keeps a
 * successful result back as the tool turn's; a later result carries that turn's usage.
 */
async function* reportedTurn(
  stream: AsyncIterable<MessageChunk>,
  call: CallState,
  turn: { holdsSuccess: boolean; catalogId: string | undefined; abortSignal?: AbortSignal }
): AsyncGenerator<MessageChunk> {
  for await (const chunk of closeOpenToolCalls(stream, { resultEndsTurn: true })) {
    if (chunk.type === 'result') {
      if (turn.holdsSuccess && !chunk.failure) {
        call.toolTurnResult = chunk;
        continue;
      }
      withToolTurnOf(chunk, call.toolTurnResult);
      reportResult(chunk, turn.abortSignal, turn.catalogId);
      call.resultReported = true;
    }
    yield chunk;
  }
}

/**
 * The final turn reports the whole call: both turns' tokens, and whether the node's own
 * session was resumed. Its internal resume of the tool turn's thread is not one.
 */
function withToolTurnOf(final: ResultChunk, toolTurn: ResultChunk | undefined): ResultChunk {
  if (!toolTurn) return final;
  const tokens = mergeTokenUsage(
    [toolTurn.tokens, final.tokens].filter((usage): usage is TokenUsage => usage !== undefined)
  );
  if (tokens) final.tokens = tokens;
  if (toolTurn.resumed) final.resumed = true;
  else delete final.resumed;
  return final;
}

/** The tool-free turn: every tool off, the empty plugin scope, and the schema. */
function finalTurnRequestOf(
  request: Omit<TurnRequest, 'connection'>,
  turnParams: TurnRequest['turnParams'],
  launchConfig: CodexProviderDefaults
): Omit<TurnRequest, 'connection' | 'resumeSessionId'> {
  return {
    ...request,
    tools: buildCodexNativeTools([]),
    forkSession: false,
    // The empty title scope: no plugin, app or MCP server, which the thread check enforces.
    nodePlugins: [],
    threadParams: {
      ...request.threadParams,
      config: { ...buildThreadConfig(launchConfig, undefined, true), ...TOOL_FREE_THREAD_CONFIG },
    },
    turnParams,
    hasOutputFormat: true,
  };
}

/**
 * The turn `streamTurn` runs, less the connection, which starts after it is built. When the
 * output schema must not ride with the tools, the turn goes without it and `finalTurnParams`
 * is the tool-free turn that carries it.
 */
function turnRequestOf(
  prompt: string,
  cwd: string,
  requestOptions: SendQueryOptions | undefined,
  inputs: TurnInputs
): {
  request: Omit<TurnRequest, 'connection'>;
  finalTurnParams: TurnRequest['turnParams'] | undefined;
} {
  const { outputSchema, hasOutputFormat } = buildOutputSchema(requestOptions);
  const effort = resolveModelReasoningEffort(
    requestOptions?.nodeConfig,
    inputs.modelReasoningEffort
  );
  const { model, run } = inputs;
  const split = inputs.splitsStructuredOutput && outputSchema !== undefined;
  const finalTurnParams = split
    ? {
        input: [{ type: 'text' as const, text: FINAL_ANSWER_INSTRUCTION, text_elements: [] }],
        ...(effort ? { effort } : {}),
        outputSchema,
      }
    : undefined;
  // Multi-agent is fixed when the thread starts, so a split thread starts without it.
  const threadConfig = split
    ? { ...inputs.threadConfig, features: { multi_agent: false } }
    : inputs.threadConfig;
  const request: Omit<TurnRequest, 'connection'> = {
    abortSignal: requestOptions?.abortSignal,
    tools: inputs.tools,
    login: inputs.login,
    cwd,
    resumeSessionId: inputs.resumeThreadId,
    forkSession: requestOptions?.forkSession === true,
    authoritativeCredential: Object.values(CODEX_CREDENTIAL_ENV).some(
      key => requestOptions?.userCredentialEnvKeys?.includes(key) && requestOptions.env?.[key]
    ),
    threadParams: {
      sandbox: inputs.titleRequest ? 'read-only' : 'danger-full-access',
      approvalPolicy: 'never',
      ...(model ? { model } : {}),
      config: threadConfig,
    },
    turnParams: {
      input: [
        { type: 'text', text: buildEffectivePrompt(prompt, requestOptions), text_elements: [] },
      ],
      ...(effort ? { effort } : {}),
      ...(outputSchema !== undefined && !split ? { outputSchema } : {}),
    },
    nodePlugins: inputs.nodePlugins,
    hasOutputFormat: hasOutputFormat && !split,
    model,
    onThread: id => {
      run.threadId = id;
    },
    onTurn: id => {
      run.turnId = id;
    },
  };
  return { request, finalTurnParams };
}
