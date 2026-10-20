import { randomUUID } from 'node:crypto';
import { execFileAsync } from './exec';

export async function resolvePushDestinations(repoPath: string, remote: string): Promise<string[]> {
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
  if (!urls.length) urls.push(remote);
  const insteadOf = configuredRewrites(settings, '.insteadof');
  const pushInsteadOf = configuredRewrites(settings, '.pushinsteadof');
  // Git applies insteadOf to explicit pushurls, but pushInsteadOf to original fallback URLs.
  // Both resolution and newline validation must use this same NUL-delimited snapshot.
  const pushed = urls.flatMap(url => {
    const rewritten = rewriteUrl(url, pushInsteadOf);
    return rewritten ? [rewritten] : [];
  });
  const destinations = pushUrls.length
    ? pushUrls.map(url => rewriteUrl(url, insteadOf) ?? url)
    : pushed.length
      ? pushed
      : urls.map(url => rewriteUrl(url, insteadOf) ?? url);
  return destinations;
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

/** Pin Git's single URL rewrite to an already resolved endpoint for reads and pushes. */
export function pinGitDestination(destination: string): {
  endpoint: string;
  env: NodeJS.ProcessEnv;
} {
  const endpoint = `archon-cleanup-${randomUUID()}:`;
  const env = { ...process.env };
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid GIT_CONFIG_COUNT');
  for (const [offset, setting] of ['insteadOf', 'pushInsteadOf'].entries()) {
    env[`GIT_CONFIG_KEY_${String(count + offset)}`] = `url.${destination}.${setting}`;
    env[`GIT_CONFIG_VALUE_${String(count + offset)}`] = endpoint;
  }
  env.GIT_CONFIG_COUNT = String(count + 2);
  return { endpoint, env };
}
