import { z } from 'astro/zod';
import {
  PLUGIN_MANIFEST_FILE,
  isPluginPathSegment,
  pluginManifestSchema,
  type PluginManifest,
} from '../../../plugin-manifest/src/index';
import denylist from '../../plugin-denylist.json';

const repositorySchema = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  default_branch: z.string().min(1),
  archived: z.boolean(),
});
const searchSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(repositorySchema),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({ path: z.string(), type: z.string(), mode: z.string(), sha: z.string() })
  ),
});
const commitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
const tagsSchema = z.array(z.object({ name: z.string() }));
const blobSchema = z.object({ encoding: z.literal('base64'), content: z.string() });

export interface ListedPlugin {
  id: string;
  manifest: PluginManifest;
  commit: string;
  archived: boolean;
  latestTag: string | null;
  sourceUrl: string;
  readmeUrl: string;
  installCommand: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function discoverPlugins({
  fetch: request = globalThis.fetch,
  token = process.env.GITHUB_TOKEN,
  deniedRepositories = denylist.repositories,
  log = console.warn,
}: {
  fetch?: Fetch;
  token?: string;
  deniedRepositories?: readonly string[];
  log?: (message: string) => void;
} = {}): Promise<ListedPlugin[]> {
  const denied = new Set(deniedRepositories.map(repository => repository.toLowerCase()));
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  async function github(path: string): Promise<unknown> {
    const response = await request(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  }

  const repositories = new Map<string, z.infer<typeof repositorySchema>>();
  for (let page = 1; ; page++) {
    const result = searchSchema.parse(
      await github(
        `/search/repositories?q=topic%3Aarchon-plugin+is%3Apublic&per_page=100&page=${page}`
      )
    );
    if (result.incomplete_results || result.total_count > 1000) {
      throw new Error(
        'GitHub topic search is incomplete; refusing to publish a partial plugin index'
      );
    }
    for (const repository of result.items) repositories.set(repository.full_name, repository);
    if (page * 100 >= result.total_count) break;
  }

  const plugins: ListedPlugin[] = [];
  for (const repository of repositories.values()) {
    const repo = repository.full_name;
    if (denied.has(repo.toLowerCase())) {
      log(`[plugins] Skipping ${repo}: denylisted repository`);
      continue;
    }
    const { sha: commit } = commitSchema.parse(
      await github(`/repos/${repo}/commits/${encodeURIComponent(repository.default_branch)}`)
    );
    const tree = treeSchema.parse(await github(`/repos/${repo}/git/trees/${commit}?recursive=1`));
    if (tree.truncated)
      throw new Error(`GitHub tree for ${repo} is truncated; refusing a partial index`);
    const tags = tagsSchema.parse(await github(`/repos/${repo}/tags?per_page=1`));
    for (const file of tree.tree) {
      if (file.path.split('/').at(-1) !== PLUGIN_MANIFEST_FILE) continue;
      const directory = file.path.slice(0, -PLUGIN_MANIFEST_FILE.length).replace(/\/$/, '');
      const id = directory ? `${repo}/${directory}` : repo;
      if (
        file.type !== 'blob' ||
        (file.mode !== '100644' && file.mode !== '100755') ||
        (directory && !directory.split('/').every(isPluginPathSegment))
      ) {
        log(
          `[plugins] Skipping ${repo}/${file.path}: unsupported install path or non-regular manifest`
        );
        continue;
      }
      const blob = blobSchema.parse(await github(`/repos/${repo}/git/blobs/${file.sha}`));
      let manifest: PluginManifest;
      try {
        const value: unknown = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
        manifest = pluginManifestSchema.parse(value);
      } catch (error) {
        log(
          `[plugins] Skipping ${repo}/${file.path}: invalid manifest: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      const sourceUrl = `https://github.com/${repo}/tree/${commit}${directory ? `/${directory.split('/').map(encodeURIComponent).join('/')}` : ''}`;
      const readme = tree.tree.find(
        entry =>
          entry.type === 'blob' &&
          entry.path.toLowerCase() === `${directory ? `${directory}/` : ''}README.md`.toLowerCase()
      );
      plugins.push({
        id,
        manifest,
        commit,
        archived: repository.archived,
        latestTag: tags[0]?.name ?? null,
        sourceUrl,
        readmeUrl: readme
          ? `https://github.com/${repo}/blob/${commit}/${readme.path.split('/').map(encodeURIComponent).join('/')}`
          : `${sourceUrl}#readme`,
        installCommand: `archon plugin install ${id}`,
      });
    }
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}

let index: Promise<ListedPlugin[]> | undefined;
export function getPluginIndex(): Promise<ListedPlugin[]> {
  return (index ??= discoverPlugins());
}
