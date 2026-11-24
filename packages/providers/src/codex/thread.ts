import { z } from 'zod';
import { BUNDLED_VERSION } from '@archon/paths';
import { heartbeatSchema } from '@archon/provider-contract';
import { withDeliveredCredentialConfig } from './login';
import { applyNodeScope, checkThreadMcpScope, readCodexInventory } from './scope';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { TurnRequest } from './stream';

/** The Codex home the app-server reports in its `initialize` response, for error messages. */
function codexHomeOf(initializeResponse: unknown): string {
  const home =
    typeof initializeResponse === 'object' && initializeResponse !== null
      ? (initializeResponse as { codexHome?: unknown }).codexHome
      : undefined;
  return typeof home === 'string' && home.length > 0 ? home : 'the Codex home';
}

/**
 * Initialize the connection, log in, and start, continue or fork the thread with the
 * request's config, scoped to the node's plugins and MCP servers when it declares them.
 */
export async function openThread(
  request: Pick<
    TurnRequest,
    | 'connection'
    | 'nodePlugins'
    | 'login'
    | 'tools'
    | 'threadParams'
    | 'cwd'
    | 'authoritativeCredential'
    | 'resumeSessionId'
    | 'forkSession'
    | 'onThread'
  >
): Promise<{
  threadId: string;
  instructionSources: ThreadStartResponse['instructionSources'] | undefined;
}> {
  const { connection, nodePlugins, login, tools } = request;
  const initialized = await connection.request('initialize', {
    clientInfo: { name: 'archon', title: 'Archon', version: BUNDLED_VERSION },
    // Host tools and external ChatGPT tokens both require Codex's experimental API.
    capabilities:
      tools.specs.length || login?.type === 'chatgptAuthTokens'
        ? { experimentalApi: true, requestAttestation: false }
        : null,
  });
  connection.notify('initialized');
  if (login) {
    // The credential stays in this process's memory: the app-server was started with the
    // ephemeral credential store, so nothing reaches the user's CODEX_HOME.
    await connection.request('account/login/start', login);
  }

  let { threadParams } = request;
  if (request.authoritativeCredential) {
    threadParams = await withDeliveredCredentialConfig(connection, request.cwd, threadParams);
  }
  let declared: string[] | undefined;
  if (nodePlugins) {
    const inventory = await readCodexInventory(connection, {
      cwd: request.cwd,
      plugins: nodePlugins,
      codexHome: codexHomeOf(initialized),
    });
    const scope = applyNodeScope(threadParams.config ?? {}, inventory, nodePlugins);
    threadParams = { ...threadParams, config: scope.config };
    declared = scope.declared;
  }
  // A resumed or forked thread needs the same config: Codex does not store it with the
  // thread, and a fork without it loads the user's MCP servers and plugins again.
  const threadResponse = request.resumeSessionId
    ? await connection.request(request.forkSession ? 'thread/fork' : 'thread/resume', {
        threadId: request.resumeSessionId,
        cwd: request.cwd,
        ...threadParams,
        excludeTurns: true,
      })
    : await connection.request('thread/start', {
        cwd: request.cwd,
        ...threadParams,
        ...(tools.specs.length ? { dynamicTools: tools.specs } : {}),
      });
  const parsed = z
    .object({ thread: z.object({ id: z.string().min(1) }) })
    .safeParse(threadResponse);
  if (!parsed.success) throw new Error('Codex app-server returned a thread without an id');
  const threadId = parsed.data.thread.id;
  request.onThread(threadId);
  if (declared) await checkThreadMcpScope(connection, threadId, declared);
  const sources = heartbeatSchema.pick({ instructionSources: true }).safeParse(threadResponse);
  return {
    threadId,
    instructionSources: sources.success ? sources.data.instructionSources : undefined,
  };
}
