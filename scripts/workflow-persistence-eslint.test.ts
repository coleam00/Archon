import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackTempRoots } from '@archon/paths/test-utils';

const track = trackTempRoots();

test('typed lint preserves the workflow persistence boundary through resolved modules and symbols', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'workflow-persistence-eslint-')));
  const write = (path: string, content: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  symlinkSync(resolve(import.meta.dir, '../node_modules'), join(root, 'node_modules'), 'junction');
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'Bundler',
        strict: true,
      },
      include: ['**/*.ts'],
    })
  );
  write(
    'packages/core/src/db/store.ts',
    'export const store = 1; export default store; export type Store = number;'
  );
  write('packages/core/src/workflows/sql-host.ts', 'export const sqlHost = 1;');
  write('packages/core/src/workflows/store-adapter.ts', 'export const adapter = 1;');
  write('safe.ts', 'export const safe = 1;');
  write(
    'barrel.ts',
    "export { store as alias, default, type Store } from './packages/core/src/db/store'; export { safe } from './safe';"
  );
  write('second.ts', "export { alias as renamed } from './barrel';");
  write('cycle-a.ts', "export * from './cycle-b'; export { alias } from './barrel';");
  write('cycle-b.ts', "export * from './cycle-a';");
  const db = '../packages/core/src/db/store';
  const absolute = join(root, 'packages/core/src/db/store.ts').replaceAll('\\', '/');
  const rejected = [
    `import { store } from '${db}';`,
    `import { store } from ${JSON.stringify(absolute)};`,
    "import { sqlHost } from '../packages/core/src/workflows/sql-host';",
    "import { adapter } from '../packages/core/src/workflows/store-adapter';",
    "import { alias as local } from '../barrel';",
    "import { renamed } from '../second';",
    "import * as ns from '../barrel';",
    "import defaultStore from '../barrel';",
    "import '../barrel';",
    "export { safe } from '../barrel';",
    "export * from '../barrel';",
    "export * as ns from '../barrel';",
    `export { store } from '${db}';`,
    `import('${db}');`,
    'import(`' + db + '`);',
    `require('${db}');`,
    'require(`' + db + '`);',
    `import { type Store } from '${db}';`,
    "import * as ns from '../cycle-a';",
  ];
  const accepted = [
    "import { safe } from '../barrel';",
    "import type { Store } from '../barrel';",
    `import type { Store } from '${db}';`,
    `export type { Store } from '${db}';`,
    "import { type Store, safe } from '../barrel';",
    "import { type Store } from '../barrel';",
    'const path = "store"; import(path); require(path);',
    "import '../safe';",
  ];
  const cases = [
    ...rejected.map(source => ({ source, rejected: true })),
    ...accepted.map(source => ({ source, rejected: false })),
  ];
  for (const [index, item] of cases.entries()) write(`consumers/${index}.ts`, item.source);
  write('outside.ts', "import './packages/core/src/db/store';");
  const ruleURL = pathToFileURL(resolve(import.meta.dir, 'workflow-persistence-rule.mjs')).href;
  const consumersURL = pathToFileURL(
    resolve(import.meta.dir, 'workflow-persistence-consumers.mjs')
  ).href;
  write(
    'harness.mjs',
    `
    import { ESLint } from 'eslint';
    import tseslint from 'typescript-eslint';
    import rule from ${JSON.stringify(ruleURL)};
    import { workflowPersistenceConsumers } from ${JSON.stringify(consumersURL)};
    const eslint = new ESLint({ cwd: ${JSON.stringify(root)}, overrideConfigFile: true, overrideConfig: [{
      files: ['**/*.ts'], languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: ${JSON.stringify(root)} } },
    }, {
      files: ['consumers/*.ts'], plugins: { archon: { rules: { persistence: rule } } }, rules: { 'archon/persistence': 'error' },
    }] });
    const production = new ESLint({ cwd: ${JSON.stringify(resolve(import.meta.dir, '..'))} });
    for (const file of workflowPersistenceConsumers) {
      const config = await production.calculateConfigForFile(file);
      if (config?.rules['archon/no-workflow-persistence']?.[0] !== 2) {
        throw new Error('Persistence boundary missing for ' + file);
      }
    }
    const results = await eslint.lintFiles(['consumers/*.ts', 'outside.ts']);
    console.log(JSON.stringify(results.map(result => ({ file: result.filePath, messages: result.messages }))));
  `
  );
  const child = Bun.spawn(['node', join(root, 'harness.mjs')], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  const results: { file: string; messages: { ruleId: string; message: string }[] }[] =
    JSON.parse(stdout);
  for (const [index, item] of cases.entries()) {
    const result = results.find(result => result.file === join(root, 'consumers', `${index}.ts`));
    expect(result, item.source).toBeDefined();
    expect(result?.messages.length ?? 0, item.source).toBe(item.rejected ? 1 : 0);
    if (item.rejected) expect(result?.messages[0].ruleId).toBe('archon/persistence');
  }
  expect(results.find(result => result.file === join(root, 'outside.ts'))?.messages).toEqual([]);
});
