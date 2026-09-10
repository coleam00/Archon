import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PI_PROVIDER_ENV_VARS, PI_OAUTH_ENV_VARS, parsePiModelRef } from '@archon/providers';
import type { MergedConfig } from '@archon/core';

export interface PiCredentialStatus {
  provider: string;
  kind: 'oauth' | 'api_key';
  status: 'valid' | 'expired' | 'invalid' | 'unreachable';
  expires?: number;
  message?: string;
}

export interface PiAuthInspectionResult {
  exists: boolean;
  error?: string;
  entries: PiCredentialStatus[];
}

export function formatExpiryDate(ms: number): string {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(ms);
  const day = d.getUTCDate();
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const month = monthNames[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

export function parseExpires(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) {
    // If epoch seconds (10 digits), convert to ms
    return val < 10_000_000_000 ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const num = Number(val);
    if (!isNaN(num) && Number.isFinite(num)) {
      return num < 10_000_000_000 ? num * 1000 : num;
    }
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return parsed;
  }
  return undefined;
}

export function defaultReadAuthJson(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export async function probePiCredential(
  provider: string
): Promise<'ready' | 'invalid' | 'unreachable'> {
  try {
    const { execFileAsync } = await import('@archon/git');
    const { stdout } = await execFileAsync(
      'pi',
      ['auth', 'check', '--provider', provider, '--json'],
      {
        timeout: 5000,
      }
    );
    const parsed = JSON.parse(stdout) as { status?: string };
    if (parsed.status === 'ready') return 'ready';
    return 'invalid';
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('ENOENT')) {
      // pi command not found — cannot probe via CLI
      return 'ready';
    }
    if (
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('network') ||
      msg.includes('fetch failed')
    ) {
      return 'unreachable';
    }
    return 'invalid';
  }
}

export async function inspectPiAuthJson(
  authJsonPath: string,
  now: number = Date.now(),
  readFn: (path: string) => string | null = defaultReadAuthJson,
  probeFn?: (provider: string) => Promise<'ready' | 'invalid' | 'unreachable'>
): Promise<PiAuthInspectionResult> {
  const content = readFn(authJsonPath);
  if (content === null) {
    return { exists: false, entries: [] };
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return { exists: true, error: (err as Error).message, entries: [] };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { exists: true, error: 'expected JSON object', entries: [] };
  }

  const entries: PiCredentialStatus[] = [];
  for (const [provider, rawCred] of Object.entries(data as Record<string, unknown>)) {
    if (typeof rawCred !== 'object' || rawCred === null) continue;
    const cred = rawCred as Record<string, unknown>;
    const type = cred.type;

    if (type === 'oauth') {
      const expires = parseExpires(cred.expires);
      if (expires !== undefined) {
        if (now >= expires) {
          entries.push({
            provider,
            kind: 'oauth',
            status: 'expired',
            expires,
            message: `${provider} credential expired ${formatExpiryDate(expires)}`,
          });
        } else {
          entries.push({
            provider,
            kind: 'oauth',
            status: 'valid',
            expires,
          });
        }
      } else {
        // OAuth credential with no expires field
        if (probeFn) {
          try {
            const probeResult = await probeFn(provider);
            if (probeResult === 'ready') {
              entries.push({ provider, kind: 'oauth', status: 'valid' });
            } else if (probeResult === 'unreachable') {
              entries.push({
                provider,
                kind: 'oauth',
                status: 'unreachable',
                message: `${provider} unreachable`,
              });
            } else {
              entries.push({
                provider,
                kind: 'oauth',
                status: 'invalid',
                message: `${provider} credential invalid`,
              });
            }
          } catch (err) {
            entries.push({
              provider,
              kind: 'oauth',
              status: 'unreachable',
              message: `${provider} unreachable (${(err as Error).message})`,
            });
          }
        } else {
          if (typeof cred.access === 'string' && cred.access.length > 0) {
            entries.push({ provider, kind: 'oauth', status: 'valid' });
          } else {
            entries.push({
              provider,
              kind: 'oauth',
              status: 'invalid',
              message: `${provider} credential invalid (missing access token)`,
            });
          }
        }
      }
    } else if (type === 'api_key') {
      if (typeof cred.key === 'string' && cred.key.trim().length > 0) {
        entries.push({ provider, kind: 'api_key', status: 'valid' });
      } else {
        entries.push({
          provider,
          kind: 'api_key',
          status: 'invalid',
          message: `${provider} API key missing or empty`,
        });
      }
    }
  }

  return { exists: true, entries };
}

function readPiSettingsDefaultProvider(): string | undefined {
  try {
    const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json');
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        defaultProvider?: unknown;
      };
      if (typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.trim().length > 0) {
        return parsed.defaultProvider.trim();
      }
    }
  } catch {
    // non-fatal
  }
  return undefined;
}

export function collectWorkflowRequiredProviders(
  workflow: { provider?: string; model?: string; nodes?: readonly unknown[] },
  config?: MergedConfig
): Set<string> {
  const providers = new Set<string>();

  function inspectNode(node: Record<string, unknown>): void {
    if (node.kind === 'loop_group' || 'loop_group' in node) {
      const loopGroup = (node.loop_group ?? node.body) as { nodes?: unknown[] } | undefined;
      if (Array.isArray(loopGroup?.nodes)) {
        for (const child of loopGroup.nodes) {
          if (typeof child === 'object' && child !== null) {
            inspectNode(child as Record<string, unknown>);
          }
        }
      }
      return;
    }

    // Only nodes that invoke AI reasoning with a configured provider or model
    const isAi =
      node.kind === 'loop' ||
      'prompt' in node ||
      'loop' in node ||
      (node.kind === 'agent' &&
        (typeof node.source !== 'object' ||
          (node as { source?: { kind?: string } }).source?.kind === 'inline'));
    if (!isAi) return;

    let provider =
      (typeof node.provider === 'string' ? node.provider : undefined) ?? workflow.provider;
    let model = (typeof node.model === 'string' ? node.model : undefined) ?? workflow.model;

    // Resolve model tier or alias preset in config
    if (model && config?.tiers && (model === 'small' || model === 'medium' || model === 'large')) {
      const preset = config.tiers[model];
      if (preset?.provider) provider = preset.provider;
      if (preset?.model) model = preset.model;
    } else if (model && config?.aliases && model in config.aliases) {
      const preset = config.aliases[model];
      if (preset?.provider) provider = preset.provider;
      if (preset?.model) model = preset.model;
    }

    if (provider === 'pi') {
      if (!model && config?.assistants?.pi?.model) {
        model = config.assistants.pi.model;
      }
      if (model) {
        const parsed = parsePiModelRef(model);
        if (parsed) {
          providers.add(parsed.provider);
          return;
        }
      }
      const settingsProvider = readPiSettingsDefaultProvider();
      if (settingsProvider) {
        providers.add(settingsProvider);
        return;
      }
      providers.add('pi');
    } else if (provider) {
      providers.add(provider);
    }
  }

  for (const node of (workflow.nodes ?? []) as Record<string, unknown>[]) {
    if (typeof node === 'object' && node !== null) {
      inspectNode(node);
    }
  }

  return providers;
}

export async function assertWorkflowCredentialsValid(
  workflow: { name: string; provider?: string; model?: string; nodes?: readonly unknown[] },
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    config?: MergedConfig;
    authJsonPath?: string;
    now?: number;
    readAuthJson?: (path: string) => string | null;
  }
): Promise<void> {
  const env = options?.env ?? process.env;
  const config = options?.config;
  const now = options?.now ?? Date.now();
  const readFn = options?.readAuthJson ?? defaultReadAuthJson;

  const requiredProviders = collectWorkflowRequiredProviders(workflow, config);
  if (requiredProviders.size === 0) return;

  const authJsonPath =
    options?.authJsonPath ??
    env.ARCHON_PI_AUTH_PATH ??
    join(homedir(), '.pi', 'agent', 'auth.json');
  const piAuth = await inspectPiAuthJson(authJsonPath, now, readFn);

  for (const provider of requiredProviders) {
    // 1. Check env vars
    const envKey = PI_PROVIDER_ENV_VARS[provider];
    if (envKey && (env[envKey] ?? '').trim().length > 0) {
      continue;
    }
    const oauthKey = PI_OAUTH_ENV_VARS[provider];
    if (oauthKey && (env[oauthKey] ?? '').trim().length > 0) {
      continue;
    }
    if (
      (provider === 'claude' || provider === 'anthropic') &&
      ((env.ANTHROPIC_API_KEY ?? '').trim().length > 0 ||
        (env.CLAUDE_CODE_TOKEN ?? '').trim().length > 0)
    ) {
      continue;
    }
    if (
      (provider === 'codex' || provider === 'openai') &&
      (env.OPENAI_API_KEY ?? '').trim().length > 0
    ) {
      continue;
    }

    // 2. Check pi auth.json
    if (piAuth.exists && !piAuth.error) {
      const entry = piAuth.entries.find(e => e.provider === provider);
      if (entry) {
        if (entry.status === 'expired') {
          const expStr = entry.expires !== undefined ? ` ${formatExpiryDate(entry.expires)}` : '';
          throw new Error(`${provider} credential expired${expStr}`);
        }
        if (entry.status === 'invalid') {
          throw new Error(
            `${provider} credential invalid${entry.message ? `: ${entry.message}` : ''}`
          );
        }
        if (entry.status === 'valid') {
          continue;
        }
      }
    }

    // 3. Check DB credentials (if CLI user has a connected key)
    const cliId = env.ARCHON_USER_ID || env.USER || env.USERNAME;
    if (cliId) {
      try {
        const { getUserProviderKeyRecord } = await import('@archon/core');
        const userDb = await import('@archon/core/db/users');
        const { decryptToken, getEncryptionKey } = await import('@archon/core/utils/token-crypto');
        const user = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
        const row = await getUserProviderKeyRecord(user.id, provider);
        if (row) {
          if (row.kind === 'oauth' && row.oauth_creds_encrypted) {
            const key = getEncryptionKey();
            const parsed = JSON.parse(decryptToken(row.oauth_creds_encrypted, key)) as {
              expires?: number;
            };
            if (
              parsed &&
              typeof parsed === 'object' &&
              typeof parsed.expires === 'number' &&
              Number.isFinite(parsed.expires)
            ) {
              if (now >= parsed.expires) {
                throw new Error(
                  `${provider} credential expired ${formatExpiryDate(parsed.expires)}`
                );
              }
            }
          }
          continue;
        }
      } catch (err) {
        if ((err as Error).message.includes('expired')) {
          throw err;
        }
      }
    }
  }
}
