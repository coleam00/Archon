import { execFileAsync } from './exec';
import { getRemoteUrl } from './repo';
import type { RepoPath } from './types';

export const GITHUB_CLI_TOKEN_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
type GitHubCliTokenEnvVar = (typeof GITHUB_CLI_TOKEN_ENV_VARS)[number];

export type GitHubCliAuthPreference = 'inherit' | 'prefer-stored' | 'prefer-env';
export type GitHubCliAuthSource = 'env' | 'stored' | 'ambient';

interface GhAuthHostEntry {
  state?: string;
  active?: boolean;
  host?: string;
  login?: string;
  tokenSource?: string;
  scopes?: string;
  gitProtocol?: string;
}

interface GhAuthStatusPayload {
  hosts?: Record<string, GhAuthHostEntry[]>;
}

export interface GitHubCliAuthDecision {
  env: NodeJS.ProcessEnv;
  preference: GitHubCliAuthPreference;
  host: string | null;
  isGitHubHost: boolean;
  envTokenNames: GitHubCliTokenEnvVar[];
  envTokenPresent: boolean;
  storedAuthAvailable: boolean;
  chosenAuthSource: GitHubCliAuthSource;
  activeLogin: string | null;
  storedLogin: string | null;
  actorSwitchDetected: boolean;
  reason:
    | 'inherit'
    | 'prefer-env'
    | 'no_env_token'
    | 'non_github_remote'
    | 'no_stored_auth'
    | 'prefer_stored'
    | 'status_unavailable';
}

export interface GitHubCliAuthOptions {
  preference?: GitHubCliAuthPreference;
  env?: NodeJS.ProcessEnv;
  host?: string;
  repoPath?: RepoPath;
  timeoutMs?: number;
  /** Internal test seam: override the gh/git exec wrapper. */
  execFile?: typeof execFileAsync;
  /** Internal test seam: override origin remote lookup. */
  getRemoteUrl?: typeof getRemoteUrl;
}

export interface ExecGhWithAuthOptions extends GitHubCliAuthOptions {
  cwd?: string;
  maxBuffer?: number;
  mutation?: boolean;
  allowActorSwitch?: boolean;
}

export interface ExecGhWithAuthResult {
  stdout: string;
  stderr: string;
  decision: GitHubCliAuthDecision;
}

function cloneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env };
}

function getEnvTokenNames(env: NodeJS.ProcessEnv): GitHubCliTokenEnvVar[] {
  return GITHUB_CLI_TOKEN_ENV_VARS.filter(name => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

export function stripGitHubCliTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GH_TOKEN: ghToken, GITHUB_TOKEN: githubToken, ...nextEnv } = env;
  void ghToken;
  void githubToken;
  return nextEnv;
}

function isEnvTokenSource(source: string | undefined): boolean {
  return source === 'GH_TOKEN' || source === 'GITHUB_TOKEN';
}

function isStoredTokenSource(source: string | undefined): boolean {
  return typeof source === 'string' && source.length > 0 && !isEnvTokenSource(source);
}

function firstSuccessfulEntry(entries: GhAuthHostEntry[]): GhAuthHostEntry | null {
  return (
    entries.find(entry => entry.state === 'success' && entry.active) ??
    entries.find(entry => entry.state === 'success') ??
    null
  );
}

function firstSuccessfulStoredEntry(entries: GhAuthHostEntry[]): GhAuthHostEntry | null {
  return (
    entries.find(
      entry => entry.state === 'success' && entry.active && isStoredTokenSource(entry.tokenSource)
    ) ??
    entries.find(entry => entry.state === 'success' && isStoredTokenSource(entry.tokenSource)) ??
    null
  );
}

async function getGhAuthEntriesForHost(
  host: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  execFile: typeof execFileAsync
): Promise<GhAuthHostEntry[] | null> {
  try {
    const { stdout } = await execFile(
      'gh',
      ['auth', 'status', '--hostname', host, '--json', 'hosts'],
      { timeout: timeoutMs, env }
    );
    const parsed = JSON.parse(stdout) as GhAuthStatusPayload;
    const hostEntries = parsed.hosts?.[host];
    return Array.isArray(hostEntries) ? hostEntries : [];
  } catch {
    return null;
  }
}

export function parseGitHubHostFromRemoteUrl(remoteUrl: string | null | undefined): string | null {
  const normalized = remoteUrl?.trim();
  if (!normalized) return null;

  const sshLike = /^(?:ssh:\/\/)?git@([^/:]+)[:/]/i.exec(normalized);
  if (sshLike?.[1]) {
    const host = sshLike[1].toLowerCase();
    return host.includes('github') ? host : null;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    return host.includes('github') ? host : null;
  } catch {
    return null;
  }
}

export async function getGitHubHostForRepo(repoPath: RepoPath): Promise<string | null> {
  const remoteUrl = await getRemoteUrl(repoPath);
  return parseGitHubHostFromRemoteUrl(remoteUrl);
}

export async function resolveGitHubCliAuthDecision(
  options: GitHubCliAuthOptions = {}
): Promise<GitHubCliAuthDecision> {
  const preference = options.preference ?? 'inherit';
  const baseEnv = cloneEnv(options.env ?? process.env);
  const envTokenNames = getEnvTokenNames(baseEnv);
  const envTokenPresent = envTokenNames.length > 0;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const execFile = options.execFile ?? execFileAsync;
  const resolveRemoteUrl = options.getRemoteUrl ?? getRemoteUrl;

  let host = options.host ?? null;
  let nonGitHubRemoteDetected = false;
  if (!host && options.repoPath) {
    const remoteUrl = await resolveRemoteUrl(options.repoPath);
    if (remoteUrl) {
      host = parseGitHubHostFromRemoteUrl(remoteUrl);
      nonGitHubRemoteDetected = host === null;
    }
  }
  if (
    !host &&
    !nonGitHubRemoteDetected &&
    (preference === 'prefer-stored' || preference === 'prefer-env')
  ) {
    host = 'github.com';
  }

  if (!host) {
    return {
      env: baseEnv,
      preference,
      host: null,
      isGitHubHost: false,
      envTokenNames,
      envTokenPresent,
      storedAuthAvailable: false,
      chosenAuthSource: envTokenPresent ? 'env' : 'ambient',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      reason: nonGitHubRemoteDetected || !envTokenPresent ? 'non_github_remote' : 'inherit',
    };
  }

  const isGitHubHost = host.includes('github');
  if (!isGitHubHost) {
    return {
      env: baseEnv,
      preference,
      host,
      isGitHubHost,
      envTokenNames,
      envTokenPresent,
      storedAuthAvailable: false,
      chosenAuthSource: envTokenPresent ? 'env' : 'ambient',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      reason: 'non_github_remote',
    };
  }

  if (preference === 'inherit') {
    return {
      env: baseEnv,
      preference,
      host,
      isGitHubHost,
      envTokenNames,
      envTokenPresent,
      storedAuthAvailable: false,
      chosenAuthSource: envTokenPresent ? 'env' : 'ambient',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      reason: 'inherit',
    };
  }

  if (preference === 'prefer-env') {
    return {
      env: baseEnv,
      preference,
      host,
      isGitHubHost,
      envTokenNames,
      envTokenPresent,
      storedAuthAvailable: false,
      chosenAuthSource: envTokenPresent ? 'env' : 'ambient',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      reason: 'prefer-env',
    };
  }

  if (!envTokenPresent) {
    return {
      env: baseEnv,
      preference,
      host,
      isGitHubHost,
      envTokenNames,
      envTokenPresent,
      storedAuthAvailable: false,
      chosenAuthSource: 'ambient',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      reason: 'no_env_token',
    };
  }

  const hostEntries = await getGhAuthEntriesForHost(host, baseEnv, timeoutMs, execFile);
  if (hostEntries === null) {
    return {
      env: baseEnv,
      preference,
      host,
      isGitHubHost,
      envTokenNames,
      envTokenPresent,
      storedAuthAvailable: false,
      chosenAuthSource: 'env',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      reason: 'status_unavailable',
    };
  }

  const activeEntry = firstSuccessfulEntry(hostEntries);
  const storedEntry = firstSuccessfulStoredEntry(hostEntries);
  if (!storedEntry) {
    return {
      env: baseEnv,
      preference,
      host,
      isGitHubHost,
      envTokenNames,
      envTokenPresent,
      storedAuthAvailable: false,
      chosenAuthSource: 'env',
      activeLogin: activeEntry?.login ?? null,
      storedLogin: null,
      actorSwitchDetected: false,
      reason: 'no_stored_auth',
    };
  }

  const nextEnv = stripGitHubCliTokens(baseEnv);
  const activeLogin = activeEntry?.login ?? null;
  const storedLogin = storedEntry.login ?? null;

  return {
    env: nextEnv,
    preference,
    host,
    isGitHubHost,
    envTokenNames,
    envTokenPresent,
    storedAuthAvailable: true,
    chosenAuthSource: 'stored',
    activeLogin,
    storedLogin,
    actorSwitchDetected:
      typeof activeLogin === 'string' &&
      activeLogin.length > 0 &&
      typeof storedLogin === 'string' &&
      storedLogin.length > 0 &&
      activeLogin !== storedLogin,
    reason: 'prefer_stored',
  };
}

export async function execGhWithAuthPolicy(
  args: string[],
  options: ExecGhWithAuthOptions = {}
): Promise<ExecGhWithAuthResult> {
  const execFile = options.execFile ?? execFileAsync;
  const decision = await resolveGitHubCliAuthDecision(options);
  if (options.mutation && decision.actorSwitchDetected && options.allowActorSwitch !== true) {
    const activeActor = decision.activeLogin ?? 'unknown-env-actor';
    const storedActor = decision.storedLogin ?? 'unknown-stored-actor';
    throw new Error(
      `Refusing GitHub mutation because auth fallback would switch actors (${activeActor} -> ${storedActor}) on ${decision.host ?? 'unknown-host'}`
    );
  }

  const result = await execFile('gh', args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    env: decision.env,
  });
  return { ...result, decision };
}
