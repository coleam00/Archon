import { execFileAsync } from '@archon/git';
import {
  describeIssues,
  isPluginPathSegment,
  PLUGIN_MANIFEST_FILE,
  pluginManifestSchema,
  type PluginManifest,
  type WorkflowPackManifest,
} from '@archon/plugin-manifest';
import type { PluginEnvironment } from './plugin-common';

export interface PluginRef {
  owner: string;
  repo: string;
  path: string[];
  /** `owner/repo[/path]` */
  id: string;
  tag?: string;
}

/**
 * What a ref resolved to: the commit and the manifest at that commit. A binary plugin's
 * files are release assets, so it always resolves to a tag; a pack may resolve to the
 * default branch head.
 */
export interface ResolvedBinarySource {
  kind: Exclude<PluginManifest['kind'], 'workflow-pack'>;
  tag: string;
  commit: string;
  manifest: Exclude<PluginManifest, WorkflowPackManifest>;
}

type ResolvedSource =
  | ResolvedBinarySource
  | { kind: 'workflow-pack'; tag?: string; commit: string; manifest: WorkflowPackManifest };

function resolved(
  tag: string | undefined,
  commit: string,
  manifest: PluginManifest
): ResolvedSource {
  if (manifest.kind === 'workflow-pack') {
    return { kind: manifest.kind, ...(tag !== undefined ? { tag } : {}), commit, manifest };
  }
  if (tag === undefined)
    throw new Error(`${manifest.kind} plugin ${manifest.name} resolved without a tag`);
  return { kind: manifest.kind, tag, commit, manifest };
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// Every part becomes a directory under the receipts tree or a URL path segment,
// so `.`/`..` and separators are refused here rather than escaping either.
export function parsePluginRef(input: string): PluginRef {
  const at = input.lastIndexOf('@');
  const tag = at === -1 ? undefined : input.slice(at + 1);
  const [owner = '', repo = '', ...path] = (at === -1 ? input : input.slice(0, at)).split('/');
  const segmentsValid = [repo, ...path].every(isPluginPathSegment);
  if (!OWNER.test(owner) || !segmentsValid || (tag !== undefined && !TAG.test(tag))) {
    throw new Error(
      `Invalid plugin "${input}". Expected owner/repo[/path][@tag], for example coleam00/Archon/plugins/forge-github`
    );
  }
  return { owner, repo, path, id: [owner, repo, ...path].join('/'), tag };
}

async function latestReleaseTag(ref: PluginRef, githubUrl: string): Promise<string> {
  const url = `${githubUrl}/${ref.owner}/${ref.repo}/releases/latest`;
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  const match =
    response.status >= 300 && response.status < 400 && location
      ? /\/releases\/tag\/([^/]+)$/.exec(new URL(location, url).pathname)
      : null;
  const tag = match ? decodeURIComponent(match[1]) : undefined;
  if (!tag || !TAG.test(tag)) {
    throw new Error(
      `Could not find the latest release of ${ref.owner}/${ref.repo} (${url} returned ${response.status}). Name a release tag: ${ref.id}@<tag>`
    );
  }
  return tag;
}

async function lsRemote(
  ref: PluginRef,
  patterns: string[],
  githubUrl: string
): Promise<Map<string, string>> {
  const remote = `${githubUrl}/${ref.owner}/${ref.repo}.git`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['ls-remote', remote, ...patterns],
      // Never prompt: a missing or private repository must fail, not wait for input.
      { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    ));
  } catch (error) {
    throw new Error(`Could not read refs of ${remote}: ${(error as Error).message}`);
  }
  return new Map(
    stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha, name] = line.split('\t');
        return [name, sha] as const;
      })
  );
}

async function resolveTagCommit(ref: PluginRef, tag: string, githubUrl: string): Promise<string> {
  const refs = await lsRemote(ref, [`refs/tags/${tag}`, `refs/tags/${tag}^{}`], githubUrl);
  // An annotated tag lists the tag object and its peeled commit; prefer the commit.
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!commit) throw new Error(`${ref.owner}/${ref.repo} has no tag ${tag}`);
  return commit;
}

async function resolveHeadCommit(ref: PluginRef, githubUrl: string): Promise<string> {
  const commit = (await lsRemote(ref, ['HEAD'], githubUrl)).get('HEAD');
  if (!commit) throw new Error(`${ref.owner}/${ref.repo} has no default branch`);
  return commit;
}

async function fetchManifest(
  ref: PluginRef,
  commit: string,
  rawUrl: string
): Promise<PluginManifest> {
  const url = `${rawUrl}/${ref.owner}/${ref.repo}/${commit}/${[...ref.path, PLUGIN_MANIFEST_FILE].join('/')}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `No ${PLUGIN_MANIFEST_FILE} for ${ref.id} at commit ${commit} (${url} returned ${response.status})`
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${url} is not valid JSON`);
  }
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid plugin manifest ${url}: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Resolve a ref to one commit and its manifest. A named tag is used as given.
 * Without one, the manifest at the default branch head decides: a workflow
 * pack goes on to fetch that ref, and the commit the fetch returns is the one
 * installed; a binary plugin's binaries exist only as release assets, so it moves
 * on to the latest release. `update` already knows the kind from its receipt.
 */
export async function resolveSource(
  ref: PluginRef,
  kind: PluginManifest['kind'] | undefined,
  env: PluginEnvironment,
  expectedCommit?: string
): Promise<ResolvedSource> {
  const githubUrl = env.githubUrl ?? 'https://github.com';
  const rawUrl = env.rawUrl ?? 'https://raw.githubusercontent.com';
  const atTag = async (tag: string): Promise<ResolvedSource> => {
    const commit = await resolveTagCommit(ref, tag, githubUrl);
    if (expectedCommit !== undefined && commit !== expectedCommit) {
      throw new Error(`${ref.id}: release resolves to ${commit}, expected ${expectedCommit}`);
    }
    return resolved(tag, commit, await fetchManifest(ref, commit, rawUrl));
  };
  if (ref.tag) return atTag(ref.tag);
  if (kind !== undefined && kind !== 'workflow-pack')
    return atTag(await latestReleaseTag(ref, githubUrl));
  const commit = await resolveHeadCommit(ref, githubUrl);
  const manifest = await fetchManifest(ref, commit, rawUrl);
  if (manifest.kind !== 'workflow-pack') return atTag(await latestReleaseTag(ref, githubUrl));
  return resolved(undefined, commit, manifest);
}
