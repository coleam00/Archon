import { resolve } from 'node:path';
import type { BunPlugin } from 'bun';

export const fixtureModules: BunPlugin = {
  name: 'slack-conformance-client',
  setup(build) {
    build.onResolve({ filter: /^@slack\/bolt$/ }, () => ({
      path: resolve(import.meta.dir, 'bolt.ts'),
    }));
    build.onResolve({ filter: /^@archon\/chat-contract$/ }, args =>
      args.importer.endsWith('/main.ts')
        ? { path: resolve(import.meta.dir, 'contract.ts') }
        : undefined
    );
  },
};

if (import.meta.main) {
  const outfile = process.argv[2];
  if (!outfile) throw new Error('Usage: build-conformance.ts <outfile>');
  if (process.platform === 'darwin') throw new Error('Compile conformance only in CI');
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../main.ts')],
    compile: { outfile },
    plugins: [fixtureModules],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Slack conformance build failed');
}
