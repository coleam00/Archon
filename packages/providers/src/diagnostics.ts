import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type {
  ProviderCredentialSourceInfo,
  ProviderDefaultsMap,
  ProviderDiagnostics,
  ProviderRegistration,
} from './types';
import { getRegisteredProviders } from './registry';

const PI_PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
};

const MODEL_EXAMPLES: Record<string, string[]> = {
  claude: ['sonnet', 'opus', 'haiku'],
  codex: ['gpt-5.3-codex', 'gpt-5.2-codex'],
  pi: ['anthropic/claude-haiku-4-5', 'openai/gpt-5-mini', 'google/gemini-2.5-pro'],
};

function formatSecretHint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return `…${trimmed}`;
  return `…${trimmed.slice(-4)}`;
}

function hasNonEmptyEnv(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0;
}

function configuredModel(
  providerId: string,
  assistants: ProviderDefaultsMap | undefined
): string | null {
  const value = assistants?.[providerId]?.model;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildClaudeDiagnostics(
  entry: ProviderRegistration,
  assistants: ProviderDefaultsMap | undefined
): ProviderDiagnostics {
  const oauthTokenValue = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKeyValue = process.env.CLAUDE_API_KEY;
  const oauthToken = hasNonEmptyEnv('CLAUDE_CODE_OAUTH_TOKEN');
  const apiKey = hasNonEmptyEnv('CLAUDE_API_KEY');
  const explicitAvailable = oauthToken || apiKey;
  const useGlobalAuth = process.env.CLAUDE_USE_GLOBAL_AUTH;

  const sources: ProviderCredentialSourceInfo[] = [
    {
      type: 'env',
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      present: oauthToken,
      active: oauthToken,
      ...(oauthTokenValue ? { displayHint: formatSecretHint(oauthTokenValue) } : {}),
    },
    {
      type: 'env',
      name: 'CLAUDE_API_KEY',
      present: apiKey,
      active: apiKey && !oauthToken,
      ...(apiKeyValue ? { displayHint: formatSecretHint(apiKeyValue) } : {}),
    },
    {
      type: 'login',
      name: 'claude /login',
      present: useGlobalAuth !== 'false' && !explicitAvailable,
      active: useGlobalAuth === 'true' && !explicitAvailable,
      note: 'Local login-based auth cannot be verified without a live Claude request.',
    },
  ];

  const notes: string[] = [];
  let mode = 'global-auth-unverified';
  let available = explicitAvailable || useGlobalAuth !== 'false';
  let verified = explicitAvailable;

  if (explicitAvailable) {
    mode = oauthToken ? 'explicit-oauth-token' : 'explicit-api-key';
    notes.push('Explicit Claude credentials detected in environment variables.');
  } else if (useGlobalAuth === 'true') {
    notes.push('Configured to rely on claude /login credentials, but access is not verified offline.');
  } else if (useGlobalAuth === 'false') {
    mode = 'explicit-required-but-missing';
    available = false;
    verified = false;
    notes.push('CLAUDE_USE_GLOBAL_AUTH=false requires explicit Claude env credentials.');
  } else {
    notes.push('No explicit Claude env credentials detected; Archon will attempt Claude global auth.');
  }

  return {
    id: entry.id,
    displayName: entry.displayName,
    builtIn: entry.builtIn,
    capabilities: entry.capabilities,
    credentialStatus: {
      available,
      verified,
      mode,
      activeCredentialHint: oauthTokenValue
        ? formatSecretHint(oauthTokenValue)
        : apiKeyValue
          ? formatSecretHint(apiKeyValue)
          : undefined,
      sources,
      notes,
    },
    modelStatus: {
      configured: configuredModel(entry.id, assistants),
      examples: MODEL_EXAMPLES.claude,
      accessVerified: false,
      notes: ['Model access is not verified until Claude accepts a live request.'],
    },
  };
}

function buildCodexDiagnostics(
  entry: ProviderRegistration,
  assistants: ProviderDefaultsMap | undefined
): ProviderDiagnostics {
  const tokenVars = [
    'CODEX_ID_TOKEN',
    'CODEX_ACCESS_TOKEN',
    'CODEX_REFRESH_TOKEN',
    'CODEX_ACCOUNT_ID',
  ] as const;
  const authFile = join(homedir(), '.codex', 'auth.json');
  const filePresent = existsSync(authFile);
  const presentVars = tokenVars.filter(hasNonEmptyEnv);

  const sources: ProviderCredentialSourceInfo[] = tokenVars.map(name => ({
    type: 'env',
    name,
    present: hasNonEmptyEnv(name),
    active: hasNonEmptyEnv(name),
    ...(hasNonEmptyEnv(name) ? { displayHint: formatSecretHint(process.env[name] ?? '') } : {}),
  }));
  sources.push({
    type: 'file',
    name: '~/.codex/auth.json',
    present: filePresent,
    active: !presentVars.length && filePresent,
  });

  const notes: string[] = [];
  if (presentVars.length > 0 && presentVars.length < tokenVars.length) {
    notes.push(
      `Only ${String(presentVars.length)}/${String(tokenVars.length)} Codex auth env vars are set; login file fallback may still work.`
    );
  } else if (presentVars.length === tokenVars.length) {
    notes.push('All expected Codex auth env vars are present.');
  } else if (filePresent) {
    notes.push('Detected Codex login file at ~/.codex/auth.json.');
  } else {
    notes.push('No Codex auth env vars or ~/.codex/auth.json detected.');
  }

  return {
    id: entry.id,
    displayName: entry.displayName,
    builtIn: entry.builtIn,
    capabilities: entry.capabilities,
    credentialStatus: {
      available: presentVars.length === tokenVars.length || filePresent,
      verified: presentVars.length === tokenVars.length || filePresent,
      mode:
        presentVars.length === tokenVars.length
          ? 'env-tokens'
          : filePresent
            ? 'auth-file'
            : 'missing',
      activeCredentialHint:
        presentVars.length > 0 ? formatSecretHint(process.env[presentVars[0]] ?? '') : undefined,
      sources,
      notes,
    },
    modelStatus: {
      configured: configuredModel(entry.id, assistants),
      examples: MODEL_EXAMPLES.codex,
      accessVerified: false,
      notes: ['Codex account/model entitlement is not verified until the SDK completes a live request.'],
    },
  };
}

function buildPiDiagnostics(
  entry: ProviderRegistration,
  assistants: ProviderDefaultsMap | undefined
): ProviderDiagnostics {
  const authFile = join(homedir(), '.pi', 'agent', 'auth.json');
  const filePresent = existsSync(authFile);
  const envSources = Object.values(PI_PROVIDER_ENV_VARS).map(name => ({
    type: 'env' as const,
    name,
    present: hasNonEmptyEnv(name),
    active: hasNonEmptyEnv(name),
    ...(hasNonEmptyEnv(name) ? { displayHint: formatSecretHint(process.env[name] ?? '') } : {}),
  }));
  const presentEnvSources = envSources.filter(source => source.present);
  const configured = configuredModel(entry.id, assistants);
  const configuredProvider = configured?.split('/')[0] ?? null;
  const modelNotes = [
    'Pi model refs use the format <provider>/<model> and depend on the upstream provider account.',
  ];
  if (configuredProvider && !(configuredProvider in PI_PROVIDER_ENV_VARS)) {
    modelNotes.push(
      `Configured Pi provider '${configuredProvider}' may rely on ~/.pi/agent/auth.json or a custom upstream auth mechanism.`
    );
  }

  return {
    id: entry.id,
    displayName: entry.displayName,
    builtIn: entry.builtIn,
    capabilities: entry.capabilities,
    credentialStatus: {
      available: filePresent || presentEnvSources.length > 0,
      verified: filePresent || presentEnvSources.length > 0,
      mode: filePresent ? 'auth-file-or-env' : presentEnvSources.length > 0 ? 'env-api-keys' : 'missing',
      activeCredentialHint:
        presentEnvSources.length > 0 ? presentEnvSources[0].displayHint : undefined,
      sources: [
        ...envSources,
        {
          type: 'file',
          name: '~/.pi/agent/auth.json',
          present: filePresent,
          active: filePresent && presentEnvSources.length === 0,
        },
      ],
      notes: filePresent
        ? ['Detected Pi auth file at ~/.pi/agent/auth.json.']
        : ['No Pi auth file detected; only the listed Pi-compatible env vars are available.'],
    },
    modelStatus: {
      configured,
      examples: MODEL_EXAMPLES.pi,
      accessVerified: false,
      notes: modelNotes,
    },
  };
}

function buildGenericDiagnostics(
  entry: ProviderRegistration,
  assistants: ProviderDefaultsMap | undefined
): ProviderDiagnostics {
  return {
    id: entry.id,
    displayName: entry.displayName,
    builtIn: entry.builtIn,
    capabilities: entry.capabilities,
    credentialStatus: {
      available: false,
      verified: false,
      mode: 'unknown',
      activeCredentialHint: undefined,
      sources: [],
      notes: ['No provider-specific diagnostics are implemented for this provider yet.'],
    },
    modelStatus: {
      configured: configuredModel(entry.id, assistants),
      examples: [],
      accessVerified: false,
      notes: ['Model access cannot be inferred for this provider.'],
    },
  };
}

export function getProviderDiagnosticsList(
  assistants?: ProviderDefaultsMap
): ProviderDiagnostics[] {
  return getRegisteredProviders().map(entry => {
    switch (entry.id) {
      case 'claude':
        return buildClaudeDiagnostics(entry, assistants);
      case 'codex':
        return buildCodexDiagnostics(entry, assistants);
      case 'pi':
        return buildPiDiagnostics(entry, assistants);
      default:
        return buildGenericDiagnostics(entry, assistants);
    }
  });
}

export function getProviderDiagnostics(
  providerId: string,
  assistants?: ProviderDefaultsMap
): ProviderDiagnostics | undefined {
  return getProviderDiagnosticsList(assistants).find(provider => provider.id === providerId);
}
