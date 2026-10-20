import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeTempTree } from '@archon/paths/test-utils';

const key = 'ARCHON_WORKFLOW_CODEBASE_ID';

test.each(['.env', '.env.local', '.env.development', '.env.production'])(
  'real boot distinguishes inherited scope from %s preload',
  async filename => {
    const root = mkdtempSync(join(tmpdir(), 'archon-scope-boot-'));
    try {
      const probe = join(root, 'probe.ts');
      writeFileSync(
        probe,
        `const preloaded = process.env.${key};
await import(${JSON.stringify(import.meta.resolve('@archon/paths/strip-cwd-env-boot'))});
const { loadCliEnv } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, 'load-cli-env.ts')).href)});
const { resolveRunIdArg } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, 'commands/workflow-shared.ts')).href)});
await loadCliEnv(process.cwd());
const id = '0b1ee8da-05ac-47fb-a85c-9912716cd678';
const queries = [];
const host = { deps: { store: { findWorkflowRunsByIdPrefix: async (ref, scope) => {
  queries.push(scope);
  return scope === 'selected-project' ? [{ id }] : [];
} } } };
try {
  const resolved = await resolveRunIdArg(host, id);
  console.log(JSON.stringify({ preloaded, scope: process.env.${key}, resolved, queries }));
} catch (error) {
  console.log(JSON.stringify({ preloaded, scope: process.env.${key}, error: error.message, queries }));
}
`
      );
      const cwd = join(root, filename.slice(1));
      const home = join(cwd, 'home');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(cwd, '.archon'));
      writeFileSync(join(cwd, filename), `${key}=foreign-project\n`);
      writeFileSync(join(home, '.env'), `${key}=home-project\n`);
      writeFileSync(join(cwd, '.archon/.env'), `${key}=repo-project\n`);
      for (const scope of [undefined, 'selected-project', '']) {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NODE_ENV: filename === '.env.production' ? 'production' : 'development',
          ARCHON_HOME: home,
          ARCHON_TELEMETRY_DISABLED: '1',
        };
        // Absence is intentional: Bun must be allowed to preload the project value.
        if (scope === undefined) delete env[key];
        else env[key] = scope;
        const result = spawnSync(process.execPath, [probe], { cwd, env, encoding: 'utf8' });
        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.preloaded).toBe(scope === undefined ? 'foreign-project' : scope);
        expect(output.scope).toBe(scope);
        if (scope === '') {
          expect(output.error).toContain('must name a registered project');
          expect(output.queries).toEqual([]);
        } else {
          expect(output.resolved).toBe('0b1ee8da-05ac-47fb-a85c-9912716cd678');
          expect(output.queries).toEqual(scope === undefined ? [] : [scope]);
        }
      }
    } finally {
      await removeTempTree(root);
    }
  }
);
