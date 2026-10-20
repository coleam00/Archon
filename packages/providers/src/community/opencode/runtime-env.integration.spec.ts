import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { acquireEmbeddedRuntime } from './runtime';

test.skipIf(process.platform === 'win32')(
  'installed SDK captures each request environment before yielding',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-opencode-env-'));
    const previousPath = process.env.PATH;
    const previousScope = process.env.ARCHON_WORKFLOW_CODEBASE_ID;
    const runtimes: Awaited<ReturnType<typeof acquireEmbeddedRuntime>>[] = [];
    try {
      await writeFile(
        join(root, 'opencode'),
        `#!/usr/bin/env bun
await Bun.write(process.env.ARCHON_TEST_ENV_OUTPUT, JSON.stringify({
  scope: process.env.ARCHON_WORKFLOW_CODEBASE_ID,
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
}));
console.log('opencode server listening on http://127.0.0.1:12345');
setInterval(() => {}, 1000);
`,
        { mode: 0o755 }
      );
      process.env.PATH = `${root}:${previousPath}`;
      await Promise.all(
        ['project-a', 'project-b'].map(async scope => {
          const output = join(root, scope);
          const runtime = await acquireEmbeddedRuntime(undefined, {
            ARCHON_WORKFLOW_CODEBASE_ID: scope,
            ARCHON_TEST_ENV_OUTPUT: output,
          });
          runtimes.push(runtime);
          const captured = JSON.parse(await readFile(output, 'utf8'));
          expect(captured.scope).toBe(scope);
          expect(captured.config).not.toHaveProperty('permission');
        })
      );
      expect(process.env.ARCHON_WORKFLOW_CODEBASE_ID).toBe(previousScope);
      expect(process.env.ARCHON_TEST_ENV_OUTPUT).toBeUndefined();
    } finally {
      for (const runtime of runtimes) runtime.server.close();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await removeTempTree(root);
    }
  }
);
