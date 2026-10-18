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

export async function generateTitleForUser(
  conversationDbId: string,
  userMessage: string,
  request: TitleRequest,
  cwd: string,
  userId?: string,
  workflowName?: string,
  credentials?: readonly UserProviderCredential[]
): Promise<void> {
  let tempDir: string | undefined;
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
    if (strict || credentials !== undefined) {
      if (strict && !userId) return skip('missing_identity');
      if (!isRegisteredProvider(request.provider)) {
        if (strict) return skip('unknown_provider');
      } else {
        const spec = getRegistration(request.provider).credentials;
        const vendor = spec.vendorFor(options.model);
        if (vendor === undefined) {
          if (strict) return skip('unresolved_vendor');
        } else {
          const records =
            credentials ?? (userId ? await resolveUserProviderCredentials(userId, vendor) : []);
          const record = records.find(entry => entry.vendor === vendor);
          if (!record || record.stored.state === 'not_connected') {
            if (strict) return skip('not_connected');
          } else if (record.stored.state !== 'usable') {
            return skip(record.stored.state);
          } else {
            const credential = record.stored.credential;
            if (!consumesStoredCredential(spec, vendor, credential.kind)) {
              return skip('incompatible_credential');
            }
            let env: Record<string, string>;
            if (request.provider === 'pi') {
              const auth = buildPiAuthJson([{ provider: vendor, cred: credential }]);
              if (auth === null) return skip('incompatible_credential');
              tempDir = await mkdtemp(join(tmpdir(), 'archon-title-auth-'));
              const path = join(tempDir, 'auth.json');
              await writeFile(path, auth, { mode: 0o600 });
              env = { [PI_AUTH_PATH_ENV]: path };
            } else {
              env = deliverCredential(record.provider, credential).env;
            }
            options.env = { ...options.env, ...env };
            options.userCredentialEnvKeys = Object.keys(env);
            options.protectedEnvKeys = [...(options.protectedEnvKeys ?? []), ...Object.keys(env)];
          }
        }
      }
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
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        log.warn({ conversationDbId }, 'title.credential_cleanup_failed');
      }
    }
  }
}
