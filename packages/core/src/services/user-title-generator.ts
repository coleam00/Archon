import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { consumesStoredCredential } from '@archon/provider-contract';
import { getRegistration, isRegisteredProvider } from '@archon/providers';
import { buildPiAuthJson, deliverCredential, PI_AUTH_PATH_ENV } from '../credentials/delivery';
import {
  resolveUserProviderCredentials,
  type UserProviderCredential,
} from '../credentials/user-provider-resolution';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import type { TitleRequest } from '../orchestrator/chat-request';
import { generateAndSetTitle } from './title-generator';

type UsableCredential = Extract<
  UserProviderCredential['stored'],
  { state: 'usable' }
>['credential'];

/** Which credentials the title request runs on, or why it is skipped. */
type TitleCredential =
  | { kind: 'skip'; reason: string }
  | { kind: 'ambient' }
  | { kind: 'user'; record: UserProviderCredential; vendor: string; credential: UsableCredential };

const AMBIENT: TitleCredential = { kind: 'ambient' };

function skipTitle(reason: string): TitleCredential {
  return { kind: 'skip', reason };
}

async function resolveTitleCredential(
  provider: string,
  model: string | undefined,
  strict: boolean,
  userId: string | undefined,
  credentials: readonly UserProviderCredential[] | undefined
): Promise<TitleCredential> {
  if (!strict && credentials === undefined) return AMBIENT;
  if (strict && !userId) return skipTitle('missing_identity');
  // Outside strict mode a credential the user has not supplied falls back to the ambient one.
  const unavailable = (reason: string): TitleCredential => (strict ? skipTitle(reason) : AMBIENT);
  if (!isRegisteredProvider(provider)) return unavailable('unknown_provider');
  const spec = getRegistration(provider).credentials;
  const vendor = spec.vendorFor(model);
  if (vendor === undefined) return unavailable('unresolved_vendor');
  const records =
    credentials ?? (userId ? await resolveUserProviderCredentials(userId, vendor) : []);
  const record = records.find(entry => entry.vendor === vendor);
  if (!record || record.stored.state === 'not_connected') return unavailable('not_connected');
  if (record.stored.state !== 'usable') return skipTitle(record.stored.state);
  const credential = record.stored.credential;
  if (!consumesStoredCredential(spec, vendor, credential.kind)) {
    return skipTitle('incompatible_credential');
  }
  return { kind: 'user', record, vendor, credential };
}

/**
 * The env that delivers the user's credential to the title provider; null when Pi cannot
 * consume it. Pi reads an auth file, written into a temp dir recorded on `scratch` so the
 * caller removes it whatever happens next.
 */
async function titleCredentialEnv(
  provider: string,
  { record, vendor, credential }: Extract<TitleCredential, { kind: 'user' }>,
  scratch: { tempDir?: string }
): Promise<Record<string, string> | null> {
  if (provider !== 'pi') return deliverCredential(record.provider, credential).env;
  const auth = buildPiAuthJson([{ provider: vendor, cred: credential }]);
  if (auth === null) return null;
  scratch.tempDir = await mkdtemp(join(tmpdir(), 'archon-title-auth-'));
  const path = join(scratch.tempDir, 'auth.json');
  await writeFile(path, auth, { mode: 0o600 });
  return { [PI_AUTH_PATH_ENV]: path };
}

export async function generateTitleForUser(
  conversationDbId: string,
  userMessage: string,
  request: TitleRequest,
  cwd: string,
  userId?: string,
  workflowName?: string,
  credentials?: readonly UserProviderCredential[]
): Promise<void> {
  const scratch: { tempDir?: string } = {};
  const log = createLogger('service.user-title-generator');
  const skip = (reason: string): void => {
    log.warn({ conversationDbId, provider: request.provider, reason }, 'title.credential_skipped');
  };
  try {
    const strict = isPerUserGitHubEnabled();
    const options = {
      ...request.options,
      model: process.env.TITLE_GENERATION_MODEL || request.options.model,
    };
    const resolved = await resolveTitleCredential(
      request.provider,
      options.model,
      strict,
      userId,
      credentials
    );
    if (resolved.kind === 'skip') return skip(resolved.reason);
    if (resolved.kind === 'user') {
      const env = await titleCredentialEnv(request.provider, resolved, scratch);
      if (env === null) return skip('incompatible_credential');
      options.env = { ...options.env, ...env };
      options.userCredentialEnvKeys = Object.keys(env);
      options.protectedEnvKeys = [...(options.protectedEnvKeys ?? []), ...Object.keys(env)];
    }
    await generateAndSetTitle(
      conversationDbId,
      userMessage,
      request.provider,
      cwd,
      workflowName,
      options.assistantConfig,
      options
    );
  } catch {
    // Credential errors can contain vendor responses; never log them with message text or secrets.
    skip('preparation_failed');
  } finally {
    if (scratch.tempDir) {
      try {
        await rm(scratch.tempDir, { recursive: true, force: true });
      } catch {
        log.warn({ conversationDbId }, 'title.credential_cleanup_failed');
      }
    }
  }
}
