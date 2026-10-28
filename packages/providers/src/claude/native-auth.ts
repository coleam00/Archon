import { exec, execFile, spawn, type ExecFileException } from 'node:child_process';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import type { CredentialStatus } from '@archon/provider-contract';
import type { IAgentProvider } from '../types';
import { resolveClaudeBinaryPath } from './binary-resolver';
import { parseClaudeConfig, resolveSettingSources } from './config';
import { buildContainerSpawn, buildDockerExecPrefix } from './container-spawn';

const nativeHelperSettingsSchema = z.object({
  response: z.object({
    effective: z.object({
      apiKeyHelper: z.string().min(1),
      env: z.record(z.string(), z.string()).optional(),
    }),
  }),
});

async function checkNativeKeyHelper(
  session: ReturnType<typeof query>,
  request: Parameters<IAgentProvider['checkCredential']>[0],
  subprocessEnv: NodeJS.ProcessEnv
): Promise<CredentialStatus> {
  // accountInfo reports a configured helper even when it fails. Read the native
  // get_settings control response so policy and subprocess env use the same cascade;
  // the host-side resolveSettings API cannot accept the subprocess environment.
  if (!('request' in session) || typeof session.request !== 'function')
    throw new Error('Claude SDK cannot inspect the native apiKeyHelper settings');
  const settings = nativeHelperSettingsSchema.parse(
    await session.request({ subtype: 'get_settings' })
  ).response.effective;
  const env = { ...subprocessEnv, ...settings.env };
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
    return { state: 'usable', source: 'native' };
  return await new Promise<CredentialStatus>((resolve, reject) => {
    const onResult = (error: ExecFileException | null, stdout: string): void => {
      if (request.signal.aborted) {
        reject(request.signal.reason);
      } else if (error) {
        resolve({
          state: 'unusable',
          source: 'native',
          evidence: `apiKeyHelper failed (${error.code ?? error.name})`,
        });
      } else if (!stdout.trim()) {
        resolve({
          state: 'unusable',
          source: 'native',
          evidence: 'apiKeyHelper returned no credential',
        });
      } else {
        resolve({ state: 'usable', source: 'native' });
      }
    };
    if (request.execContext?.kind === 'container') {
      // The runner image can supply a key the forwarded env never saw; Claude in the
      // runner uses it, so the helper matters only when the runner has none.
      execFile(
        'docker',
        [
          ...buildDockerExecPrefix(request.execContext, request.cwd, env),
          'sh',
          '-c',
          'if [ -n "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ]; then echo runner-env; else exec sh -c "$1"; fi',
          'check-credential',
          settings.apiKeyHelper,
        ],
        { signal: request.signal },
        onResult
      );
    } else {
      exec(settings.apiKeyHelper, { cwd: request.cwd, env, signal: request.signal }, onResult);
    }
  });
}

/**
 * Check Claude's native login through its SDK account info, without a model request.
 */
export async function checkClaudeNativeAuth(
  request: Parameters<IAgentProvider['checkCredential']>[0],
  requestEnv: NodeJS.ProcessEnv
): Promise<CredentialStatus> {
  const config = parseClaudeConfig(request.assistantConfig ?? {});
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  let session: ReturnType<typeof query> | undefined;
  let closeInput: (() => void) | undefined;
  let subprocessEnv: NodeJS.ProcessEnv | undefined;
  try {
    request.signal.throwIfAborted();
    // Keep input open for control requests without sending a model prompt.
    session = query({
      prompt: (async function* () {
        await new Promise<void>(resolve => {
          closeInput = resolve;
        });
      })(),
      options: {
        env: requestEnv,
        pathToClaudeCodeExecutable:
          request.execContext?.kind === 'container'
            ? 'claude'
            : await resolveClaudeBinaryPath(config.claudeBinaryPath),
        spawnClaudeCodeProcess: options => {
          // Capture the SDK's final environment rather than duplicating its transforms.
          subprocessEnv = options.env;
          if (request.execContext?.kind === 'container')
            return buildContainerSpawn(request.execContext)(options);
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.stderr.resume();
          return child;
        },
        cwd: request.cwd,
        settingSources: [...resolveSettingSources(request.settingSources, config)],
        abortController: controller,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        plugins: [],
      },
    });
    const account = await session.accountInfo();
    request.signal.throwIfAborted();
    // Cloud backends resolve credentials outside Claude's first-party account store.
    if (account.apiProvider && account.apiProvider !== 'firstParty')
      return { state: 'not_checked', source: 'native' };
    if (account.apiKeySource === 'apiKeyHelper' || account.tokenSource === 'apiKeyHelper') {
      if (!subprocessEnv) throw new Error('Claude SDK did not expose its subprocess environment');
      return await checkNativeKeyHelper(session, request, subprocessEnv);
    }
    const sources = [account.tokenSource, account.apiKeySource].filter(Boolean);
    // A claude.ai subscription login reports the account but no credential source, while a
    // logged-out CLI reports tokenSource 'none' and no account. A reported source decides;
    // without one, the account identity does.
    const hasCredential =
      sources.length > 0
        ? sources.some(source => source !== 'none')
        : Boolean(account.email || account.subscriptionType);
    return { state: hasCredential ? 'usable' : 'not_connected', source: 'native' };
  } catch (error) {
    request.signal.throwIfAborted();
    return {
      state: 'check_failed',
      source: 'native',
      evidence:
        redactCredentialValues(
          error instanceof Error ? error.message : String(error),
          collectCredentialValues({ ...process.env, ...request.env })
        ) || 'Claude account check failed',
    };
  } finally {
    closeInput?.();
    session?.close();
    controller.abort();
    request.signal.removeEventListener('abort', abort);
  }
}
