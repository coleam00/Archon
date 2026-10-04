const pack = {
  schemaVersion: 1,
  kind: 'workflow-pack',
  name: 'review-kit',
  description: '<script>alert(1)</script> Review workflows',
  entrypoints: { review: 'review/review.yaml' },
};
const forge = {
  schemaVersion: 1,
  kind: 'forge',
  name: 'example-forge',
  description: 'Example forge',
  executable: 'archon-forge-example',
};
export const commit = 'a'.repeat(40);
export function fixtureResponse(url) {
  const { pathname, searchParams } = new URL(url);
  if (pathname === '/search/repositories') {
    if (searchParams.get('q') !== 'topic:archon-plugin is:public fork:true')
      throw new Error('Expected topic search');
    return {
      total_count: 3,
      incomplete_results: false,
      items: [
        { full_name: 'test-author/test-pack', default_branch: 'main', archived: false, fork: true },
        { full_name: 'test-author/invalid-pack', default_branch: 'main', archived: false },
        { full_name: 'test-author/archived-forge', default_branch: 'main', archived: true },
      ],
    };
  }
  if (pathname.endsWith('/commits/main')) return { sha: commit };
  if (pathname.includes('/git/trees/'))
    return {
      truncated: false,
      tree: [
        { path: 'archon-plugin.json', type: 'blob', mode: '100644', sha: 'root' },
        { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme' },
        ...(pathname.includes('test-pack')
          ? [
              {
                path: 'packs/second/archon-plugin.json',
                type: 'blob',
                mode: '100644',
                sha: 'nested',
              },
            ]
          : []),
      ],
    };
  if (pathname.endsWith('/tags'))
    return pathname.includes('invalid-pack') ? [] : [{ name: 'v1.0.0' }];
  if (pathname.includes('/git/blobs/')) {
    const manifest = pathname.includes('invalid-pack')
      ? { ...pack, schemaVersion: 99 }
      : pathname.includes('archived-forge')
        ? forge
        : pack;
    return {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
    };
  }
  throw new Error(`Unexpected GitHub fixture request: ${url}`);
}
