import { randomUUID } from 'node:crypto';
import { execFileAsync } from './exec';

export interface PushDestination {
  url: string;
}

export async function resolvePushDestinations(
  repoPath: string,
  remote: string
): Promise<PushDestination[]> {
  const { stdout: config } = await execFileAsync(
    'git',
    ['-C', repoPath, 'config', '--null', '--list'],
    { timeout: 10000 }
  );
  const settings = config
    .split('\0')
    .filter(Boolean)
    .map(record => {
      const separator = record.indexOf('\n');
      return separator < 0
        ? { key: record, value: undefined }
        : { key: record.slice(0, separator), value: record.slice(separator + 1) };
    });
  const urls = configuredUrls(settings, `remote.${remote}.url`);
  const pushUrls = configuredUrls(settings, `remote.${remote}.pushurl`);
  const insteadOf = configuredRewrites(settings, '.insteadof');
  const pushInsteadOf = configuredRewrites(settings, '.pushinsteadof');
  const destinations = pushUrls.map(url => rewriteUrl(url, insteadOf) ?? url);
  // Git adds the remote-name fallback after rewriting configured URLs, so its
  // generated push URL can append to (or, when empty, reset) explicit pushurls.
  const aliasSources = urls.length ? (pushUrls.length ? [] : urls) : [remote];
  for (const url of aliasSources) {
    const rewritten = rewriteUrl(url, pushInsteadOf);
    if (rewritten === undefined) continue;
    if (rewritten) destinations.push(rewritten);
    else destinations.length = 0;
  }
  const fallbackUrls = urls.length ? urls : [remote];
  const effectiveUrls = destinations.length
    ? destinations
    : fallbackUrls.map(url => rewriteUrl(url, insteadOf) ?? url);
  // Service commands can redirect independently of the URL and each other.
  // An upload advertisement then cannot prove absence at the receiver.
  if (
    settings.some(
      ({ key }) => key === `remote.${remote}.uploadpack` || key === `remote.${remote}.receivepack`
    )
  ) {
    throw new Error('Cannot verify receiving endpoints with remote service overrides');
  }
  if (settings.some(({ key }) => key === `remote.${remote}.vcs`)) {
    throw new Error('Cannot verify receiving endpoints with a remote transport helper');
  }
  return effectiveUrls.map(url => ({ url }));
}

type GitSetting = { key: string; value: string | undefined };

function configuredUrls(settings: GitSetting[], key: string): string[] {
  const urls: string[] = [];
  for (const setting of settings) {
    if (setting.key !== key) continue;
    if (setting.value === undefined) throw new Error('Push destination requires a URL value');
    if (setting.value.includes('\n'))
      throw new Error('Newlines in push destination configuration are unsupported');
    if (setting.value) urls.push(setting.value);
    else urls.length = 0;
  }
  return urls;
}

function configuredRewrites(settings: GitSetting[], suffix: string): Map<string, string[]> {
  const rewrites = new Map<string, string[]>();
  for (const { key, value } of settings) {
    if (!key.startsWith('url.') || !key.endsWith(suffix) || key.length < 4 + suffix.length)
      continue;
    if (value === undefined) throw new Error('URL rewrite requires a prefix value');
    const base = key.slice(4, -suffix.length);
    const prefixes = rewrites.get(base) ?? [];
    prefixes.push(value);
    rewrites.set(base, prefixes);
  }
  return rewrites;
}

function rewriteUrl(url: string, rewrites: Map<string, string[]>): string | undefined {
  let longest: string | undefined;
  let destination: string | undefined;
  for (const [base, prefixes] of rewrites) {
    for (const prefix of prefixes) {
      if (url.startsWith(prefix) && (longest === undefined || prefix.length > longest.length)) {
        longest = prefix;
        destination = base + url.slice(prefix.length);
      }
    }
  }
  return destination;
}

/**
 * The named remote's alias receives one URL rewrite,
 * so Git does not rewrite the already resolved destination a second time.
 */
export function pinGitDestination(destination: PushDestination): {
  endpoint: string;
  env: NodeJS.ProcessEnv;
} {
  const endpoint = `archon-cleanup-${randomUUID()}`;
  const alias = `${endpoint}:`;
  const env = { ...process.env };
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid GIT_CONFIG_COUNT');
  const settings = [
    [`url.${destination.url}.insteadOf`, alias],
    [`url.${destination.url}.pushInsteadOf`, alias],
    [`remote.${endpoint}.url`, alias],
  ];
  for (const [offset, [key, value]] of settings.entries()) {
    env[`GIT_CONFIG_KEY_${String(count + offset)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(count + offset)}`] = value;
  }
  env.GIT_CONFIG_COUNT = String(count + settings.length);
  return { endpoint, env };
}
