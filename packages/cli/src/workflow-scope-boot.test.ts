import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeTempTree } from '@archon/paths/test-utils';

const key = 'ARCHON_WORKFLOW_CODEBASE_ID';

const cases = ['.env', '.env.local', '.env.development', '.env.production'].flatMap(filename =>
  [undefined, 'selected-project', ''].flatMap(scope =>
    ['foreign-project', ''].map(oldValue => ({ filename, scope, oldValue }))
  )
);

test.each(cases)(
  'explicit scope $scope survives $oldValue in $filename and Archon env files',
  async ({ filename, scope, oldValue }) => {
    const root = mkdtempSync(join(tmpdir(), 'archon-scope-boot-'));
    try {
      const probe = join(root, 'probe.ts');
      writeFileSync(
        probe,
        `import { mock } from 'bun:test';
const ffi = await import('bun:ffi');
mock.module('bun:ffi', () => ({ ...ffi, dlopen: () => { throw new Error('Native loading is unavailable'); } }));
const preloaded = process.env.${key};
await import(${JSON.stringify(import.meta.resolve('@archon/paths/strip-cwd-env-boot'))});
const { loadCliEnv } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, 'load-cli-env.ts')).href)});
const { readChatProjectScope } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, 'workflow-scope.ts')).href)});
const scope = readChatProjectScope();
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
  console.log(JSON.stringify({ preloaded, scope, resolved, queries }));
} catch (error) {
  console.log(JSON.stringify({ preloaded, scope, error: error.message, queries }));
}
`
      );
      const cwd = join(root, filename.slice(1));
      const home = join(cwd, 'home');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(cwd, '.archon'));
      writeFileSync(join(home, '.env'), `${key}=home-project\n`);
      writeFileSync(join(cwd, '.archon/.env'), `${key}=repo-project\n`);
      writeFileSync(join(cwd, filename), `${key}=${oldValue}\n`);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: filename === '.env.production' ? 'production' : 'development',
        ARCHON_HOME: home,
        ARCHON_TELEMETRY_DISABLED: '1',
      };
      // Absence is intentional: Bun must be allowed to preload the project value.
      delete env[key];
      const result = spawnSync(
        process.execPath,
        [probe, ...(scope === undefined ? [] : ['--chat-project-id', scope])],
        { cwd, env, encoding: 'utf8' }
      );
      const failure = {
        status: result.status,
        signal: result.signal,
        error: result.error?.message ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      expect(result.status, JSON.stringify(failure, null, 2)).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.preloaded).toBe(oldValue);
      expect(output.scope).toBe(scope);
      if (scope === '') {
        expect(output.error).toContain('must name a registered project');
        expect(output.queries).toEqual([]);
      } else {
        expect(output.resolved).toBe('0b1ee8da-05ac-47fb-a85c-9912716cd678');
        expect(output.queries).toEqual(scope === undefined ? [] : [scope]);
      }
    } finally {
      await removeTempTree(root);
    }
  }
);
