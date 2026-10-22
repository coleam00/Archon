import {
  consumesStoredCredential,
  noDefaultProviderMessage,
  unconsumedStoredCredentialReason,
} from '@archon/provider-contract';
import { getRegistration, providerRegistry } from '@archon/providers';
import type { IAgentProvider } from '@archon/providers';
import { doctorLog, loadMergedConfig, type CheckResult } from './doctor-check';
import { loadProviderDeps } from './doctor-connected-providers';

export interface AssistantLoginDeps {
  assistant: string;
  assistantConfig?: Parameters<IAgentProvider['checkCredential']>[0]['assistantConfig'];
  model?: string;
  /**
   * The credential vendor the configured model uses; undefined when Archon config names no
   * model or the model's provider has no credential vendor (a Pi models.json provider).
   */
  vendor?: string;
  /** Vendors of the user's connected credentials that this assistant can use, as delivery names them. */
  connectedVendors: readonly string[];
  /** Why the connected credential for `vendor` cannot be used by this assistant, when one is connected. */
  unconsumedConnectionReason?: string;
  provider: Pick<IAgentProvider, 'checkCredential'>;
}

export async function checkAssistantLogin(
  env: NodeJS.ProcessEnv = process.env,
  loadDeps: (env: NodeJS.ProcessEnv) => Promise<AssistantLoginDeps> = loadAssistantLoginDeps
): Promise<CheckResult> {
  const label = 'Assistant login';
  try {
    const deps = await loadDeps(env);
    if (deps.vendor !== undefined && deps.connectedVendors.includes(deps.vendor)) {
      return {
        label,
        status: 'pass',
        message: `${deps.assistant}: uses the credential connected in Archon`,
      };
    }
    const status = await deps.provider.checkCredential({
      assistantConfig: deps.assistantConfig,
      model: deps.model,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      signal: AbortSignal.timeout(20_000),
    });
    // A run receives every connected credential, and the model picks the one it uses. With
    // no model in Archon config (Pi falls back to its own default), doctor cannot tell
    // whether a connected credential covers a missing native login, so it warns instead.
    const connectedHint =
      deps.model === undefined && deps.connectedVendors.length > 0
        ? ` A run also receives your connected ${deps.connectedVendors.join(', ')} credential and uses it if its model is from that vendor; set a model in assistants.${deps.assistant} so doctor can tell.`
        : undefined;
    switch (status.state) {
      case 'usable':
        return { label, status: 'pass', message: `${deps.assistant}: usable` };
      case 'not_checked':
        // Nothing was verified, so this is not a pass.
        return { label, status: 'skip', message: `${deps.assistant}: not checked` };
      case 'check_failed':
        return {
          label,
          status: 'warn',
          message: `${deps.assistant}: could not be verified. ${status.evidence}`,
        };
      case 'unusable':
        return connectedHint
          ? {
              label,
              status: 'warn',
              message: `${deps.assistant}: native login cannot be used. ${status.evidence}${connectedHint}`,
            }
          : {
              label,
              status: 'fail',
              message: `${deps.assistant}: cannot be used. ${status.evidence} Log in through ${deps.assistant} or connect a credential with \`archon ai\`.`,
            };
      case 'not_connected':
        if (deps.unconsumedConnectionReason) {
          return {
            label,
            status: 'fail',
            message: `${deps.assistant}: no native credential, and ${deps.unconsumedConnectionReason}`,
          };
        }
        return connectedHint
          ? {
              label,
              status: 'warn',
              message: `${deps.assistant}: no native credential.${connectedHint}`,
            }
          : {
              label,
              status: 'fail',
              message: `${deps.assistant}: no native credential. Log in through ${deps.assistant} or connect a credential with \`archon ai\`.`,
            };
    }
  } catch (error) {
    return {
      label,
      status: 'warn',
      message: `could not check assistant login: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function loadAssistantLoginDeps(env: NodeJS.ProcessEnv): Promise<AssistantLoginDeps> {
  const config = await loadMergedConfig(process.cwd());
  if (config.assistant === undefined) throw new Error(noDefaultProviderMessage(providerRegistry));
  const { normalizeCredentialVendor } = await import('@archon/providers');
  const configuredModel = config.assistants[config.assistant]?.model;
  const model = typeof configuredModel === 'string' ? configuredModel : undefined;
  const registration = getRegistration(config.assistant);
  const { credentials } = registration;
  const usableVendors =
    credentials.kind === 'static' ? credentials.specs.map(spec => spec.vendor) : [];
  const cliId = env.ARCHON_USER_ID || env.USER || env.USERNAME;
  const vendor = credentials.vendorFor(model);
  let connectedVendors: string[] = [];
  let unconsumedConnectionReason: string | undefined;
  if (usableVendors.length > 0 && cliId) {
    try {
      const deps = await loadProviderDeps();
      const user = await deps.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
      // Delivery normalizes legacy agent-keyed rows to their vendor; so does this lookup.
      const rows = (await deps.listUserProviderKeys(user.id)).map(row => ({
        vendor: normalizeCredentialVendor(row.provider),
        kind: row.kind,
      }));
      connectedVendors = [
        ...new Set(
          rows
            .filter(row => consumesStoredCredential(credentials, row.vendor, row.kind))
            .map(row => row.vendor)
        ),
      ];
      const unconsumed = rows.find(
        row => row.vendor === vendor && !connectedVendors.includes(row.vendor)
      );
      if (unconsumed) {
        unconsumedConnectionReason = unconsumedStoredCredentialReason(
          providerRegistry,
          config.assistant,
          unconsumed.vendor,
          unconsumed.kind
        );
      }
    } catch (err) {
      // Best-effort, as in the Codex credential lookup: a failed lookup must not hide the
      // native login check, which runs as if nothing were connected. The AI credentials
      // check runs the same lookup and shows its error. The lookup reads only credential
      // metadata, never key material, so its error is safe to log.
      doctorLog().debug({ err }, 'doctor.assistant_login_credential_lookup_failed');
    }
  }
  return {
    assistant: config.assistant,
    assistantConfig: { ...(config.assistants[config.assistant] ?? {}) },
    model,
    vendor,
    connectedVendors,
    unconsumedConnectionReason,
    // The factory, not getAgentProvider: a credential check is not a run, so it must not
    // log the deprecation notice the Provider support check already shows.
    provider: registration.factory(),
  };
}
