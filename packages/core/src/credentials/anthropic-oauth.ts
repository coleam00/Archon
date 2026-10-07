import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseOpenAiAuthorizationInput } from './openai-oauth';
import {
  credentialString,
  subscriptionTokenRequest,
  SubscriptionOAuthError,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
  type SubscriptionOAuthCredentials,
} from './subscription-oauth';
import type { OAuthCredentials } from './delivery';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'http://localhost:53692/callback';
const COPY_CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

export class AnthropicCallbackPortBusyError extends Error {
  constructor() {
    super('Anthropic OAuth callback port is in use.');
    this.name = 'AnthropicCallbackPortBusyError';
  }
}

async function tokenRequest(
  body: Record<string, string>,
  signal?: AbortSignal,
  previous?: OAuthCredentials
): Promise<SubscriptionOAuthCredentials> {
  const data = await subscriptionTokenRequest(
    'https://platform.claude.com/v1/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
      signal,
    },
    'Anthropic token'
  );
  const access = data.access_token;
  const refresh = data.refresh_token ?? previous?.refresh;
  const expiresIn = data.expires_in;
  if (
    typeof access !== 'string' ||
    !access ||
    typeof refresh !== 'string' ||
    !refresh ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn)
  ) {
    throw new SubscriptionOAuthError(
      'Anthropic token response missing access_token/refresh_token/expires_in.'
    );
  }
  // Pi stores expiry five minutes early; existing blobs use the same epoch-ms clock.
  return {
    ...previous,
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - 300_000,
  };
}

async function login(callbacks: OAuthLoginCallbacks): Promise<SubscriptionOAuthCredentials> {
  const signal = callbacks.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const method =
    (await callbacks.onSelect({
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'copy_code', label: 'Copy code login (headless)' },
      ],
    })) ?? 'browser';
  if (method !== 'browser' && method !== 'copy_code')
    throw new SubscriptionOAuthError('Unsupported Anthropic login method.');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = method === 'browser' ? REDIRECT_URI : COPY_CODE_REDIRECT_URI;
  const url = new URL('https://claude.ai/oauth/authorize');
  url.search = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  }).toString();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  codePromise.catch(() => undefined);
  const onAbort = (): void => {
    rejectCode(new SubscriptionOAuthError('Login cancelled.'));
  };
  const server =
    method === 'browser'
      ? createServer((request, response) => {
          const callback = new URL(request.url ?? '/', REDIRECT_URI);
          let status = 400;
          let message = 'Invalid OAuth callback.';
          if (request.method !== 'GET' || callback.pathname !== '/callback') status = 404;
          else if (callback.searchParams.get('state') !== verifier)
            message = 'OAuth state mismatch.';
          else if (callback.searchParams.has('error')) {
            message = 'Anthropic authorization failed.';
            rejectCode(new SubscriptionOAuthError(message));
          } else {
            const code = callback.searchParams.get('code');
            if (code) {
              status = 200;
              message = 'Authorization received. You can close this page.';
              resolveCode(code);
            }
          }
          response.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(message);
        })
      : undefined;
  try {
    if (server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          reject(
            error.code === 'EADDRINUSE'
              ? new AnthropicCallbackPortBusyError()
              : new SubscriptionOAuthError('Anthropic callback server could not start.')
          );
        });
        server.listen(53692, process.env.PI_OAUTH_CALLBACK_HOST || '127.0.0.1', resolve);
      });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    callbacks.onAuth({
      url: url.toString(),
      instructions:
        'Complete login in your browser, then paste the code or final redirect URL if needed.',
    });
    const manual = callbacks.onManualCodeInput().then(input => {
      const parsed = parseOpenAiAuthorizationInput(input);
      if (parsed.state && parsed.state !== verifier)
        throw new SubscriptionOAuthError('OAuth state mismatch.');
      if (!parsed.code) throw new SubscriptionOAuthError('Missing authorization code.');
      return parsed.code;
    });
    const code = await Promise.race([codePromise, manual]);
    return await tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        state: verifier,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      },
      signal
    );
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (server?.listening)
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve();
        })
      );
  }
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
  usesCallbackServer: true,
  login,
  refreshToken: (credentials, options) =>
    tokenRequest(
      { grant_type: 'refresh_token', refresh_token: credentialString(credentials, 'refresh') },
      options?.signal,
      credentials
    ),
  getApiKey: async credentials => ({ apiKey: credentialString(credentials, 'access') }),
};
