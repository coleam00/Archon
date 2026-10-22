// @archon-test-isolated
import { expect, mock, spyOn, test } from 'bun:test';
import * as paths from '@archon/paths';
import * as prompts from '@clack/prompts';
import { clearRegistry, codexDescriptor, providerRegistry } from '@archon/providers';
import { loadProviderPlugins } from '@archon/core/providers/load-provider-plugins';
import { readReceipts } from '@archon/plugin-manifest/store';
import { removeTempTree } from '@archon/paths/test-utils';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseRepo, serveFixtureGit } from '../test-support/plugin-fixture';
import * as plugin from './plugin-install';

mock.module('@archon/paths', () => ({ ...paths, BUNDLED_IS_BINARY: true }));
const { collectAIConfig } = await import('./setup-ai');

test.skipIf(process.platform === 'win32')(
  'binary setup adds a provider through the real command and loads its receipt',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-setup-provider-'));
    const savedHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    const tag = `v${paths.BUNDLED_VERSION}`;
    const repo = join(root, 'repo');
    const script = join(root, 'provider.js');
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const bytes = new TextEncoder().encode(
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`
    );
    const executable = 'archon-provider-codex';
    const asset = `${executable}-${process.platform}-${process.arch}`;
    let server: ReturnType<typeof Bun.serve> | undefined;
    const spies: { mockRestore(): void }[] = [];
    clearRegistry();
    try {
      await createReleaseRepo(repo, [{ tag }]);
      await writeFile(
        script,
        `const descriptor = ${JSON.stringify(codexDescriptor)};
for await (const line of console) {
  const request = JSON.parse(line);
  console.log(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{protocolVersion:1, agentCapabilities:{_meta:{archon:descriptor}}, authMethods:[]}}));
}`
      );
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const path = decodeURIComponent(new URL(request.url).pathname);
          const git = await serveFixtureGit(repo, path, ['coleam00/Archon']);
          if (git) return git;
          if (path.endsWith('/plugins/provider-codex/archon-plugin.json')) {
            return Response.json({
              schemaVersion: 1,
              kind: 'provider',
              name: 'codex',
              description: 'Setup fixture',
              executable,
            });
          }
          if (path.endsWith('/checksums.txt')) {
            return new Response(`${createHash('sha256').update(bytes).digest('hex')}  ${asset}\n`);
          }
          if (path.endsWith(`/${asset}`)) return new Response(bytes);
          return new Response(null, { status: 404 });
        },
      });
      const origin = server.url.origin;
      const replace = plugin.replacePlugin;
      // Redirect only the network boundary; setup, provider dispatch and receipt writing stay real.
      spies.push(
        spyOn(plugin, 'replacePlugin').mockImplementation((ref, env) =>
          replace(ref, {
            ...env,
            githubUrl: origin,
            rawUrl: `${origin}/raw`,
          })
        )
      );
      spies.push(spyOn(prompts, 'confirm').mockResolvedValue(false));
      spies.push(spyOn(prompts, 'select').mockResolvedValue('__keep__'));
      spies.push(spyOn(prompts.log, 'info').mockImplementation(() => undefined));
      spies.push(spyOn(prompts.log, 'warning').mockImplementation(() => undefined));
      const config = await collectAIConfig(
        { repoPath: root, providers: ['codex'] },
        undefined,
        async () => []
      );
      expect(config.defaultAssistant).toBe('codex');
      const pluginsDir = paths.getPluginsPath();
      expect(await readReceipts(pluginsDir)).toMatchObject([
        { id: 'coleam00/Archon/plugins/provider-codex', tag, descriptor: { id: 'codex' } },
      ]);
      expect(
        (await loadProviderPlugins(pluginsDir, { maintained: 'installed' })).map(
          provider => provider.id
        )
      ).toEqual(['codex']);
      expect(providerRegistry.get('codex')?.id).toBe('codex');
    } finally {
      for (const spy of spies) spy.mockRestore();
      await server?.stop(true);
      clearRegistry();
      if (savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedHome;
      await removeTempTree(root);
    }
  },
  30_000
);
