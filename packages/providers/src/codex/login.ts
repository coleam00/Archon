/**
 * The credential a Codex app-server runs with: the login Archon hands it in memory,
 * the env it starts with, and the request config that makes a delivered credential
 * the only one the thread's model provider can use.
 */
import { randomUUID } from 'node:crypto';
import type { CodexProviderDefaults } from '../types';
import { ClassifiedProviderError } from '../shared/failure';
import type { AppServerConnection, ParamsOf } from './app-server';
import { resolveCodexBinary } from './binary-resolver';
import { parseCodexConfig } from './config';
import { CODEX_CREDENTIAL_ENV } from './credential-env';
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse';

/** A credential Archon hands the app-server in memory, never through the user's CODEX_HOME. */
export type CodexLogin = Extract<
  ParamsOf<'account/login/start'>,
  { type: 'apiKey' | 'chatgptAuthTokens' }
>;

/**
 * The login the env opts into: managed ChatGPT tokens win over `CODEX_API_KEY`, as a
 * connected user's credential wins over install-level env. Without either Codex uses the
 * user's own login. Half a token pair throws: falling back would bill another account.
 */
export function codexLogin(env: Record<string, string>): CodexLogin | undefined {
  const accessToken = env[CODEX_CREDENTIAL_ENV.chatgptAccessToken] || undefined;
  const chatgptAccountId = env[CODEX_CREDENTIAL_ENV.chatgptAccountId] || undefined;
  if (accessToken && chatgptAccountId) {
    return { type: 'chatgptAuthTokens', accessToken, chatgptAccountId };
  }
  if (accessToken || chatgptAccountId) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `A managed ChatGPT login needs both ${CODEX_CREDENTIAL_ENV.chatgptAccessToken} and ${CODEX_CREDENTIAL_ENV.chatgptAccountId}; only one is set.`
    );
  }
  const apiKey = env[CODEX_CREDENTIAL_ENV.apiKey] || undefined;
  return apiKey ? { type: 'apiKey', apiKey } : undefined;
}

/**
 * What a Codex app-server starts with: the process env with the request env on top (managed
 * project env wins on collisions) and the configured binary. The login check starts the
 * same app-server a turn does.
 */
export function codexLaunch(
  assistantConfig: Record<string, unknown> | undefined,
  requestEnv?: Record<string, string>,
  userCredentialEnvKeys?: readonly string[]
): {
  config: CodexProviderDefaults;
  env: Record<string, string>;
  resolveBinary: () => ReturnType<typeof resolveCodexBinary>;
} {
  const config = parseCodexConfig(assistantConfig ?? {});
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const env = { ...baseEnv, ...requestEnv };
  const deliveredKey =
    userCredentialEnvKeys?.includes(CODEX_CREDENTIAL_ENV.apiKey) &&
    requestEnv?.[CODEX_CREDENTIAL_ENV.apiKey];
  const deliveredSubscription =
    userCredentialEnvKeys?.includes(CODEX_CREDENTIAL_ENV.chatgptAccessToken) &&
    requestEnv?.[CODEX_CREDENTIAL_ENV.chatgptAccessToken];
  if (deliveredKey) {
    delete env[CODEX_CREDENTIAL_ENV.chatgptAccessToken];
    delete env[CODEX_CREDENTIAL_ENV.chatgptAccountId];
  } else if (deliveredSubscription) {
    delete env[CODEX_CREDENTIAL_ENV.apiKey];
  }
  return {
    config,
    env,
    resolveBinary: () => resolveCodexBinary(config.codexBinaryPath),
  };
}

/** The thread/start fields Archon sets, as `streamTurn` receives them. */
export type ThreadParams = Pick<
  ParamsOf<'thread/start'>,
  'sandbox' | 'approvalPolicy' | 'model' | 'config'
>;

/**
 * The thread params with the selected model provider copied into a fresh entry that
 * requires the OpenAI login and carries none of the provider's own auth fields or
 * credential headers, so the delivered credential is the one the thread uses.
 */
export async function withDeliveredCredentialConfig(
  connection: AppServerConnection,
  cwd: string,
  threadParams: ThreadParams
): Promise<ThreadParams> {
  const { config } = (await connection.request('config/read', {
    cwd,
  })) as ConfigReadResponse;
  const providers = config.model_providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const selected = providers[config.model_provider ?? 'openai'];
    if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
      const provider = Object.fromEntries(
        Object.entries(selected).filter(([, value]) => value !== null && value !== undefined)
      );
      delete provider.auth;
      delete provider.env_key;
      delete provider.experimental_bearer_token;
      provider.requires_openai_auth = true;
      for (const field of ['http_headers', 'env_http_headers']) {
        const headers = provider[field];
        if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
          provider[field] = Object.fromEntries(
            Object.entries(headers).filter(
              ([name, value]) =>
                value !== undefined &&
                !['authorization', 'api-key', 'x-api-key', 'chatgpt-account-id'].includes(
                  name.toLowerCase()
                )
            )
          );
        }
      }
      // A fresh entry avoids native recursive config merging restoring removed auth fields.
      const id = `archon_request_${randomUUID().replaceAll('-', '')}`;
      threadParams = {
        ...threadParams,
        config: {
          ...threadParams.config,
          model_provider: id,
          [`model_providers.${id}`]: provider,
        },
      };
    }
  }
  return threadParams;
}
