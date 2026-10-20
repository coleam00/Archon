import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { acquireEmbeddedRuntime } from './runtime';

test.skipIf(process.platform === 'win32').each([undefined, 'host'])(
  'installed SDK isolates request env and reserved credentials (host: %s)',
  async host => {
    const root = await mkdtemp(join(tmpdir(), 'archon-opencode-env-'));
    const previousPath = process.env.PATH;
    const previousCredentials = {
      OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
      OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
    };
    const previousScope = process.env.ARCHON_WORKFLOW_CODEBASE_ID;
    const runtimes: Awaited<ReturnType<typeof acquireEmbeddedRuntime>>[] = [];
    try {
      await writeFile(
        join(root, 'opencode'),
        `#!/usr/bin/env bun
await Bun.write(process.env.ARCHON_TEST_ENV_OUTPUT, JSON.stringify({
  scope: process.env.ARCHON_WORKFLOW_CODEBASE_ID,
  password: process.env.OPENCODE_SERVER_PASSWORD,
  username: process.env.OPENCODE_SERVER_USERNAME,
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
}));
console.log('opencode server listening on http://127.0.0.1:12345');
setInterval(() => {}, 1000);
`,
        { mode: 0o755 }
      );
      if (host === undefined) {
        delete process.env.OPENCODE_SERVER_PASSWORD;
        delete process.env.OPENCODE_SERVER_USERNAME;
      } else {
        process.env.OPENCODE_SERVER_PASSWORD = `${host}-password`;
        process.env.OPENCODE_SERVER_USERNAME = `${host}-username`;
      }
      process.env.PATH = `${root}:${previousPath}`;
      await Promise.all(
        ['project-a', 'project-b'].map(async scope => {
          const output = join(root, scope);
          const runtime = await acquireEmbeddedRuntime(undefined, {
            ARCHON_WORKFLOW_CODEBASE_ID: scope,
            OPENCODE_SERVER_PASSWORD: 'request-password',
            OPENCODE_SERVER_USERNAME: 'request-username',
            ARCHON_TEST_ENV_OUTPUT: output,
          });
          runtimes.push(runtime);
          const captured = JSON.parse(await readFile(output, 'utf8'));
          expect(captured.password).toBeUndefined();
          expect(captured.username).toBeUndefined();
          expect(captured.scope).toBe(scope);
          expect(captured.config).not.toHaveProperty('permission');
        })
      );
      expect(process.env.OPENCODE_SERVER_PASSWORD).toBe(
        host === undefined ? undefined : `${host}-password`
      );
      expect(process.env.OPENCODE_SERVER_USERNAME).toBe(
        host === undefined ? undefined : `${host}-username`
      );
      expect(process.env.ARCHON_WORKFLOW_CODEBASE_ID).toBe(previousScope);
      expect(process.env.ARCHON_TEST_ENV_OUTPUT).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previousCredentials)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const runtime of runtimes) runtime.server.close();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await removeTempTree(root);
    }
  }
);
