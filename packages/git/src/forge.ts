import { URL } from 'url';

export type ForgeType = 'github' | 'gitlab' | 'unknown';

export interface ForgeContext {
  type: ForgeType;
  apiBase: string;
  webBase: string;
  cli?: string;
}

/**
 * Detect forge type from a git remote URL.
 * Supports HTTPS/SSH/scp-like syntax (git@host:owner/repo.git).
 */
export function detectForgeType(remoteUrl: string | null | undefined): ForgeType {
  if (!remoteUrl) return 'unknown';

  const host = extractRemoteHost(remoteUrl)?.toLowerCase();
  if (!host) return 'unknown';

  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab';

  return 'unknown';
}

/**
 * Resolve normalized forge runtime context from git remote + optional env overrides.
 */
export function resolveForgeContext(params: {
  remoteUrl?: string | null;
  env?: NodeJS.ProcessEnv;
}): ForgeContext {
  const env = params.env ?? process.env;
  const type = detectForgeType(params.remoteUrl);

  if (type === 'github') {
    return {
      type,
      apiBase: 'https://api.github.com',
      webBase: 'https://github.com',
      cli: 'gh',
    };
  }

  if (type === 'gitlab') {
    const configuredGitlabUrl = normalizeUrlBase(env.GITLAB_URL);
    const webBase =
      configuredGitlabUrl ?? extractRemoteWebBase(params.remoteUrl) ?? 'https://gitlab.com';
    return {
      type,
      apiBase: `${webBase}/api/v4`,
      webBase,
      cli: 'glab',
    };
  }

  return {
    type: 'unknown',
    apiBase: '',
    webBase: '',
  };
}

function extractRemoteHost(remoteUrl: string): string | null {
  try {
    const parsed = new URL(remoteUrl);
    return parsed.hostname;
  } catch {
    // scp-like form: git@host:owner/repo.git
    const scpLike = /^[^@\s]+@([^:\s]+):.+$/.exec(remoteUrl.trim());
    if (scpLike) return scpLike[1] ?? null;
    return null;
  }
}

function extractRemoteWebBase(remoteUrl?: string | null): string | null {
  if (!remoteUrl) return null;

  try {
    const parsed = new URL(remoteUrl);
    if (!parsed.hostname) return null;
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    const scpLike = /^[^@\s]+@([^:\s]+):.+$/.exec(remoteUrl.trim());
    if (!scpLike?.[1]) return null;
    return `https://${scpLike[1]}`;
  }
}

function normalizeUrlBase(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return null;
  }
}
