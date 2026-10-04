import { expect, test } from 'bun:test';
import { discoverPlugins } from './plugins';
import { commit, fixtureResponse } from '../../tests/github-fixture.mjs';

function fixture() {
  const requests: string[] = [];
  const messages: string[] = [];
  return {
    requests,
    messages,
    options: {
      token: 'fixture-token',
      fetch: async (url: string, init?: RequestInit) => {
        requests.push(url);
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
        return Response.json(fixtureResponse(url));
      },
      log: (message: string) => {
        messages.push(message);
      },
    },
  };
}

test('topic search lists independent root and nested plugins at a frozen commit', async () => {
  const { options, requests, messages } = fixture();
  const plugins = await discoverPlugins(options);
  expect(plugins.map(plugin => plugin.id)).toEqual([
    'test-author/archived-forge',
    'test-author/test-pack',
    'test-author/test-pack/packs/second',
  ]);
  expect(plugins[0]).toMatchObject({
    archived: true,
    latestTag: 'v1.0.0',
    manifest: { kind: 'forge' },
  });
  expect(plugins[2]).toMatchObject({
    commit,
    installCommand: 'archon plugin install test-author/test-pack/packs/second',
    sourceUrl: `https://github.com/test-author/test-pack/tree/${commit}/packs/second`,
  });
  expect(requests.some(url => url.includes('git/trees/' + commit))).toBe(true);
  expect(
    messages.some(
      message =>
        message.includes('invalid-pack/archon-plugin.json') && message.includes('schemaVersion')
    )
  ).toBe(true);
});

test('denylist excludes repositories before reading their manifests, ignoring case', async () => {
  const { options, requests, messages } = fixture();
  const plugins = await discoverPlugins({
    ...options,
    deniedRepositories: ['TEST-AUTHOR/TEST-PACK'],
  });
  expect(plugins.map(plugin => plugin.id)).toEqual(['test-author/archived-forge']);
  expect(requests.some(url => url.includes('/repos/test-author/test-pack/'))).toBe(false);
  expect(messages).toContain('[plugins] Skipping test-author/test-pack: denylisted repository');
});

test('malformed JSON is skipped with a reason', async () => {
  const messages: string[] = [];
  const plugins = await discoverPlugins({
    fetch: async url =>
      Response.json(
        url.includes('/git/blobs/')
          ? { encoding: 'base64', content: Buffer.from('{').toString('base64') }
          : fixtureResponse(url)
      ),
    log: message => {
      messages.push(message);
    },
  });
  expect(plugins).toEqual([]);
  expect(messages.length).toBe(4);
  expect(messages.every(message => message.includes('invalid manifest'))).toBe(true);
});

for (const condition of ['incomplete search', 'search limit', 'truncated tree', 'HTTP failure']) {
  test(`${condition} fails the build instead of publishing partial results`, async () => {
    await expect(
      discoverPlugins({
        fetch: async url => {
          if (condition === 'HTTP failure') return new Response('', { status: 403 });
          if (url.includes('/search/')) {
            if (condition === 'incomplete search')
              return Response.json({ total_count: 1, incomplete_results: true, items: [] });
            if (condition === 'search limit')
              return Response.json({ total_count: 1001, incomplete_results: false, items: [] });
          }
          if (condition === 'truncated tree' && url.includes('/git/trees/'))
            return Response.json({ truncated: true, tree: [] });
          return Response.json(fixtureResponse(url));
        },
      })
    ).rejects.toThrow();
  });
}

test('search paginates beyond the first hundred repositories', async () => {
  const denied = Array.from({ length: 100 }, (_, i) => `publisher/repo-${i}`);
  const requests: string[] = [];
  const plugins = await discoverPlugins({
    deniedRepositories: denied,
    log: () => {},
    fetch: async url => {
      requests.push(url);
      if (url.includes('/search/')) {
        const items = url.endsWith('page=1')
          ? denied.map(full_name => ({ full_name, archived: false, default_branch: 'main' }))
          : [{ full_name: 'test-author/test-pack', archived: false, default_branch: 'main' }];
        return Response.json({ total_count: 101, incomplete_results: false, items });
      }
      return Response.json(fixtureResponse(url));
    },
  });
  expect(plugins.map(plugin => plugin.id)).toEqual([
    'test-author/test-pack',
    'test-author/test-pack/packs/second',
  ]);
  expect(requests.filter(url => url.includes('/search/')).length).toBe(2);
});

test('symlink manifests and paths unsupported by the installer are skipped', async () => {
  const messages: string[] = [];
  const plugins = await discoverPlugins({
    fetch: async url => {
      if (url.includes('/git/trees/'))
        return Response.json({
          truncated: false,
          tree: [
            { path: 'archon-plugin.json', type: 'blob', mode: '120000', sha: 'symlink' },
            {
              path: 'bad path/archon-plugin.json',
              type: 'blob',
              mode: '100644',
              sha: 'unsupported',
            },
          ],
        });
      if (url.includes('/git/blobs/')) throw new Error('Must not read these manifests');
      return Response.json(fixtureResponse(url));
    },
    log: message => {
      messages.push(message);
    },
  });
  expect(plugins).toEqual([]);
  expect(messages.length).toBe(6);
  expect(
    messages.every(message => message.includes('unsupported install path or non-regular manifest'))
  ).toBe(true);
});
