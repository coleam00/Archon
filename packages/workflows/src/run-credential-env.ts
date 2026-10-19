import { createLogger } from '@archon/paths';
import { prepareArtifactParent, removeArtifactFile, writeArtifactFile } from './artifact-writes';
import { delimiter, join } from 'path';
import {
  MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS,
  type WorkflowDeps,
  type WorkflowEnvironment,
} from './deps';
import {
  assertCredentialStatus,
  StoredCredentialDeliveryError,
  type RunCredentialRequirement,
} from './run-preflight';
import { GITHUB_TOKEN_KEYS, resolveGithubTokenOverrides } from './utils/github-token-policy';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/**
 * Parse `owner/repo` from a codebase's stored remote URL, which is the raw
 * `git remote get-url origin` value for locally registered repos. Accepts URL
 * forms (`https://`, `ssh://`, with or without userinfo) and scp-like
 * `[user@]github.com:owner/repo`. Returns null when the host is not github.com
 * so the caller can fall through to env-inheritance.
 *
 * Throws when the host is github.com but the path is not exactly `owner/repo`:
 * falling through there would let nodes run on whatever GitHub credential the
 * host process holds instead of the App installation token.
 */
function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
  let host: string;
  let path: string;
  if (url.includes('://')) {
    try {
      ({ hostname: host, pathname: path } = new URL(url));
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(url);
    if (!scp) return null;
    [, host, path] = scp;
  }
  host = host.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const [owner, repo, ...rest] = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (!owner || !repo || rest.length > 0) {
    // The URL is not logged: a stored remote can embed credentials in its userinfo.
    throw new Error('Codebase repository URL is on github.com but names no owner/repo');
  }
  return { owner, repo };
}

type WorkflowGithubDeps = Pick<
  WorkflowDeps,
  'githubApp' | 'isPerUserGitHubEnabled' | 'getUserGithubToken' | 'getUserGithubAuthor'
> & { store: Pick<WorkflowDeps['store'], 'getCodebase'> };

type GithubApp = NonNullable<WorkflowDeps['githubApp']>;

type WorkflowGithubCodebase =
  | string
  | Pick<
      NonNullable<Awaited<ReturnType<WorkflowGithubDeps['store']['getCodebase']>>>,
      'repository_url'
    >;

export async function resolveWorkflowGithubEnvironment(
  deps: WorkflowGithubDeps,
  codebase: WorkflowGithubCodebase | undefined,
  userId: string | undefined,
  environment: WorkflowEnvironment
): Promise<WorkflowEnvironment> {
  const installation = await resolveAppInstallationForWorkflow(deps, codebase);
  const bot: Record<string, string> = installation
    ? { GH_TOKEN: installation.token, GITHUB_TOKEN: installation.token }
    : {};
  const { env: user, protectedKeys: userProtectedKeys } = await resolveUserGithubEnvForWorkflow(
    deps,
    userId
  );
  // Only the App token is refreshed; a per-user token or scrub replaces it.
  const ghShim =
    installation && user.GH_TOKEN === undefined
      ? resolveGithubCliShimEnv(installation, environment.envVars?.PATH)
      : {};
  return {
    ...environment,
    envVars: { ...environment.envVars, ...bot, ...ghShim, ...user },
    protectedEnvKeys: [
      ...new Set([
        ...(environment.protectedEnvKeys ?? []),
        ...Object.keys(bot),
        ...userProtectedKeys,
      ]),
    ],
  };
}

async function resolveAppInstallationForWorkflow(
  deps: WorkflowGithubDeps,
  codebase: WorkflowGithubCodebase | undefined
): Promise<{ token: string; repo: string; app: GithubApp } | undefined> {
  const app = deps.githubApp;
  if (!codebase || !app) return undefined;
  const record = typeof codebase === 'string' ? await deps.store.getCodebase(codebase) : codebase;
  if (!record?.repository_url) return undefined;
  const parsed = parseGithubRepoUrl(record.repository_url);
  if (!parsed) return undefined;
  const token = await app.resolveInstallationToken(parsed.owner, parsed.repo);
  if (!token) throw new Error('GitHub App token resolution returned no installation token');
  getLog().debug({ owner: parsed.owner, repo: parsed.repo }, 'workflow.bot_github_token_injected');
  return { token, repo: `${parsed.owner}/${parsed.repo}`, app };
}

/**
 * Put the `gh` shim first on the run's PATH so each `gh` call gets a current
 * installation token instead of the dispatch-time one, which can expire
 * mid-run. The shim's only token source is the App-mode server's loopback
 * endpoint, so a process without ARCHON_PORT (a standalone CLI run) keeps the
 * dispatch token. Codex shells also keep it: Codex's shell snapshot restores a
 * fixed PATH, and Archon does not override that provider setting. Windows keeps
 * it too: the shim is a POSIX script, and Windows env keys are case-insensitive,
 * so a PATH key here would sit beside the inherited `Path`.
 */
function resolveGithubCliShimEnv(
  installation: { repo: string; app: GithubApp },
  runPath: string | undefined
): Record<string, string> {
  const port = process.env.ARCHON_PORT;
  if (process.platform === 'win32' || !port) {
    getLog().warn(
      {
        repo: installation.repo,
        reason: process.platform === 'win32' ? 'windows_unsupported' : 'archon_port_unset',
      },
      'workflow.gh_token_refresh_unavailable'
    );
    return {};
  }
  const basePath = runPath ?? process.env.PATH;
  const shimDir = installation.app.installCliShim();
  return {
    PATH: basePath ? `${shimDir}${delimiter}${basePath}` : shimDir,
    ARCHON_PORT: port,
    ARCHON_GITHUB_APP_REPO: installation.repo,
  };
}

/**
 * Resolve per-user GitHub credentials and commit author for a run. When per-user mode is on
 * and the run has an originating user, this routes `gh`/`git push` through the
 * user's personal token — or scrubs the org/bot token when they haven't
 * connected (see {@link resolveGithubTokenOverrides}). Returns {} (no opinion)
 * for server-initiated runs and solo installs, leaving the bot env untouched.
 */
async function resolveUserGithubEnvForWorkflow(
  deps: WorkflowGithubDeps,
  userId: string | undefined
): Promise<{ env: Record<string, string>; protectedKeys: string[] }> {
  const perUserEnabled = deps.isPerUserGitHubEnabled?.() ?? false;
  if (!perUserEnabled) return { env: {}, protectedKeys: [] };
  let userToken: string | undefined;
  if (userId && deps.getUserGithubToken) {
    try {
      userToken = await deps.getUserGithubToken(userId);
    } catch (err) {
      getLog().warn({ err: err as Error, userId }, 'workflow.user_github_token_resolve_failed');
    }
  }
  const env = resolveGithubTokenOverrides(perUserEnabled, userId, userToken);
  // The scrub's GH_CONFIG_DIR and GIT_CONFIG_PARAMETERS redirect config; they are not
  // secrets. Protecting them would redact their values from every node's output.
  const protectedKeys = Object.keys(env).filter(key => GITHUB_TOKEN_KEYS.includes(key));
  if (userId && deps.getUserGithubAuthor) {
    const author = await deps.getUserGithubAuthor(userId);
    if (author) {
      env.GIT_AUTHOR_NAME = author.name;
      env.GIT_AUTHOR_EMAIL = author.email;
      protectedKeys.push('GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL');
    }
  }
  return { env, protectedKeys };
}

/**
 * Remove file-delivered credentials left by an earlier invocation of this run.
 * A resume must not keep a readable credential after it has been disconnected
 * or after fresh credential resolution fails.
 */
export async function clearManagedProviderCredentialFiles(artifactsDir: string): Promise<void> {
  for (const relativePath of MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS) {
    await removeArtifactFile(join(artifactsDir, relativePath));
  }
}

/**
 * Resolve per-user AI-provider credential env (Phase 2) for a run, and write
 * any file-based deliveries (Pi's `auth.json`) under the run's artifacts
 * directory. Returns the env bag to merge LAST into
 * `config.envVars` so a connected user's keys win over file/db/bot-github
 * env, plus exact credential values for failure-path redaction. Returns empty
 * bags when per-user provider keys are disabled, no userId is present, the
 * deps adapter is absent, or preflight connected no vendor. Delivery and file-write
 * failures stop execution rather than falling back to ambient credentials.
 */
export async function resolveUserProviderEnvForWorkflow(
  deps: Pick<WorkflowDeps, 'isPerUserProviderKeysEnabled' | 'getUserProviderEnv'>,
  userId: string | undefined,
  artifactsDir: string,
  requirements: readonly RunCredentialRequirement[],
  connectedVendors: ReadonlySet<string>
): Promise<{ env: Record<string, string>; protectedValues: string[] }> {
  const perUserEnabled = deps.isPerUserProviderKeysEnabled?.() ?? false;
  if (!perUserEnabled || !userId || !deps.getUserProviderEnv) {
    return { env: {}, protectedValues: [] };
  }
  // Preflight selects only consumed credentials; delivery must not resolve other vendors.
  const vendors = [...connectedVendors];
  if (vendors.length === 0) return { env: {}, protectedValues: [] };
  let resolved: Awaited<ReturnType<NonNullable<WorkflowDeps['getUserProviderEnv']>>>;
  try {
    resolved = await deps.getUserProviderEnv(userId, artifactsDir, vendors, vendors);
  } catch (error) {
    if (error instanceof StoredCredentialDeliveryError) {
      const requirement = requirements.find(r => r.vendor === error.vendor);
      if (requirement) assertCredentialStatus(requirement, error.status);
    }
    throw new Error('Could not safely deliver required provider credentials');
  }

  const { env, files, protectedValues } = resolved;
  const written: string[] = [];
  try {
    for (const f of files) {
      await prepareArtifactParent(f.path);
      written.push(f.path);
      await writeArtifactFile(f.path, f.contents, 0o600);
    }
  } catch {
    for (const path of written.reverse()) await removeArtifactFile(path);
    await clearManagedProviderCredentialFiles(artifactsDir);
    throw new Error('Could not safely write provider credential files');
  }

  const envKeys = Object.keys(env);
  if (envKeys.length > 0) {
    getLog().debug({ userId, keys: envKeys }, 'workflow.user_provider_env_injected');
  }
  return { env, protectedValues };
}
