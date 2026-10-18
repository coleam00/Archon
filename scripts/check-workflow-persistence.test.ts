import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { findPersistenceImports } from './check-workflow-persistence';

const track = trackTempRoots();

test('the persistence boundary follows resolved modules and symbols', () => {
  const root = track(mkdtempSync(join(tmpdir(), 'workflow-persistence-')));
  const write = (path: string, content: string): string => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
    return path;
  };
  const compilerOptions = {
    target: 'ESNext',
    module: 'Preserve',
    moduleResolution: 'Bundler',
    strict: true,
  };
  write('tsconfig.json', JSON.stringify({ compilerOptions }));
  write(
    'packages/core/src/db/store.ts',
    'export const store = 1; export default store; export type Store = number;'
  );
  write('packages/core/src/workflows/sql-host.ts', 'export const sqlHost = 1;');
  write('packages/core/src/workflows/store-adapter.ts', 'export const adapter = 1;');
  write('packages/core/src/handlers/sql-registration.ts', 'export const register = 1;');
  write('packages/core/src/index.ts', 'export const contract = 1;');
  write('packages/core/src/workflows/index.ts', 'export const workflows = 1;');
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
    "import { register } from '../packages/core/src/handlers/sql-registration';",
    "import { contract } from '../packages/core/src/index';",
    "import { workflows } from '../packages/core/src/workflows';",
    "import {} from '../packages/core/src/index';",
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
    "import type { contract } from '../packages/core/src/index';",
    "import { type contract } from '../packages/core/src/index';",
  ];
  const cases = [...rejected, ...accepted];
  const files = cases.map((source, index) => write(`consumers/${index}.ts`, source));
  const violations = findPersistenceImports(root, files);
  for (const [index, source] of cases.entries()) {
    const hits = violations.filter(line => line.startsWith(`consumers/${index}.ts:`));
    expect(hits.length, source).toBe(index < rejected.length ? 1 : 0);
  }
});

test('a missing consumer fails the check instead of dropping out of it', () => {
  const root = track(mkdtempSync(join(tmpdir(), 'workflow-persistence-')));
  expect(() => findPersistenceImports(root, ['gone.ts'])).toThrow(
    'Workflow persistence consumer does not exist: gone.ts'
  );
});
