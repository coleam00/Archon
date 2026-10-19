/**
 * Clone credentials for a forge URL, resolved from environment tokens.
 */
import { githubTokenCredentials, type CloneCredentials } from '@archon/git';
import { createLogger } from '@archon/paths';
import { resolveGitHubTokenFromEnv } from '../github-auth/config';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('clone');
  return cachedLog;
}

/**
 * Parse a URL safely, returning null for non-URL strings (e.g. bare host/path).
 */
export function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

type BuildForgeCredentials = (token: string) => CloneCredentials;

const tokenAsUsername: BuildForgeCredentials = token => ({ username: token, password: '' });
const tokenAsOAuth2Password: BuildForgeCredentials = token => ({
  username: 'oauth2',
  password: token,
});

/** Forge auth config: how to resolve a token and turn it into clone credentials. */
interface ForgeAuthEntry {
  hostPattern: string;
  resolveToken: () => string | undefined;
  buildCredentials: BuildForgeCredentials;
}

/** Known exact-hostname → credential source + clone credential mappings. */
const FORGE_AUTH: ForgeAuthEntry[] = [
  {
    hostPattern: 'github.com',
    resolveToken: resolveGitHubTokenFromEnv,
    buildCredentials: githubTokenCredentials,
  },
  {
    hostPattern: 'gitlab.com',
    resolveToken: () => process.env.GITLAB_TOKEN,
    buildCredentials: tokenAsOAuth2Password,
  },
  {
    hostPattern: 'gitea.com',
    resolveToken: () => process.env.GITEA_TOKEN,
    buildCredentials: tokenAsUsername,
  },
];

/**
 * Resolve forge-specific credentials without adding them to the repository URL.
 * `url` is a clone URL that `validateCloneUrl` has normalized, so a bare
 * `host/path` has already become `https://host/path`.
 *
 * A token goes only over the scheme it was configured for: HTTPS for the known
 * forges, and the configured `*_URL`'s own scheme for a self-hosted forge. An
 * `http://` clone of the same host would send it in cleartext.
 */
export function resolveForgeAuth(url: string): CloneCredentials | undefined {
  const parsed = safeParseUrl(url);
  if (!parsed) return undefined;
  const hostname = parsed.hostname.toLowerCase();
  const authority = parsed.host.toLowerCase();

  // 1. Exact known-host match
  // A withheld token is logged, because the clone then fails as an auth error that
  // does not say why. Host and scheme only; never the token or the full URL.
  const logWithheld = (token: string | undefined, expected: string): void => {
    if (!token) return;
    getLog().warn(
      { host: authority, scheme: parsed.protocol, expectedScheme: expected },
      'clone.forge_token_withheld_insecure_scheme'
    );
  };

  for (const entry of FORGE_AUTH) {
    if (hostname === entry.hostPattern) {
      const token = entry.resolveToken();
      if (parsed.protocol !== 'https:') {
        logWithheld(token, 'https:');
        return undefined;
      }
      return token ? entry.buildCredentials(token) : undefined;
    }
  }

  // 2. Self-hosted: the clone scheme and authority must equal a configured *_URL's.
  //    A hostname that merely looks like a forge (gitlab.attacker.example) gets no
  //    token, because anyone who can submit a clone URL controls that hostname.
  const URL_FORGE: {
    urlEnvVar: string;
    resolveToken: () => string | undefined;
    buildCredentials: BuildForgeCredentials;
  }[] = [
    {
      urlEnvVar: 'GITHUB_URL',
      resolveToken: resolveGitHubTokenFromEnv,
      buildCredentials: githubTokenCredentials,
    },
    {
      urlEnvVar: 'GITEA_URL',
      resolveToken: () => process.env.GITEA_TOKEN,
      buildCredentials: tokenAsUsername,
    },
    {
      urlEnvVar: 'GITLAB_URL',
      resolveToken: () => process.env.GITLAB_TOKEN,
      buildCredentials: tokenAsOAuth2Password,
    },
    {
      urlEnvVar: 'FORGEJO_URL',
      resolveToken: () => process.env.GITEA_TOKEN,
      buildCredentials: tokenAsUsername,
    },
  ];
  for (const entry of URL_FORGE) {
    const forgeUrl = process.env[entry.urlEnvVar];
    if (forgeUrl) {
      const forgeParsed = safeParseUrl(forgeUrl);
      if (forgeParsed?.host.toLowerCase() === authority) {
        const token = entry.resolveToken();
        if (forgeParsed.protocol !== parsed.protocol) {
          logWithheld(token, forgeParsed.protocol);
          continue;
        }
        if (token) return entry.buildCredentials(token);
      }
    }
  }

  return undefined;
}
