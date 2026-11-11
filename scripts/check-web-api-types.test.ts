import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { gitOutput } from './check-test-cleanup-drift';
import { checkRepository, checkSources } from './check-web-api-types';

const file = 'packages/web/src/experiments/console/skills/probe.ts';
const imports = "import type { components as Generated, paths } from '@/lib/api.generated';\n";
const entry = "Generated['schemas']['TierEntry']";
function check(text: string): string[] {
  return checkSources(new Map([[file, imports + text]]));
}

for (const declaration of [
  'interface Independent { id: string }',
  'type Independent = { id: string }',
  'type Independent = string | number',
  'interface Independent {}',
  'type Independent = {}',
  `type Independent = ${entry} & { invented: string }`,
  `interface Independent { id: ${entry}['model']; invented: string }`,
  `type Entry = ${entry}; interface Independent extends Entry { invented: string }`,
  'namespace Inner { type Independent = boolean }',
  'type A = B; type B = A;',
  `type Independent = Pick<${entry}, 'provider'>; type Pick<T, K> = { invented: string };`,
  `function f() { type Generated = { schemas: { TierEntry: string } }; type Independent = Generated['schemas']['TierEntry']; }`,
  `import type { TierEntry } from '../primitives/settings'; type Independent = TierEntry;`,
  `import type { components as Other } from './api.generated'; type Independent = Other['schemas']['TierEntry'];`,
  `import type { components as Other } from '@/lib/api'; type Independent = Other['schemas']['TierEntry'];`,
  `import type * as API from '@/lib/api.generated'; interface Independent extends API.unrelated {}`,
  `import type * as API from './api.generated'; interface Independent extends API.components {}`,
  `import type * as API from '../primitives/settings'; interface Independent extends API.TierEntry {}`,
  `import type * as API from '@/lib/api.generated'; interface Independent extends API.components.schemas {}`,
  `import type * as API from '@/lib/api.generated'; namespace Inner { namespace API { export interface components { invented: string } } interface Independent extends API.components {} }`,
]) {
  test(`rejects independent declarations: ${declaration}`, () => {
    const name = declaration === 'type A = B; type B = A;' ? 'A' : 'Independent';
    expect(check(declaration)).toContainEqual(expect.stringContaining(` ${name}:`));
  });
}

for (const declaration of [
  `type Entry = ${entry}; type Model = Entry['model'];`,
  `type Fields = Pick<${entry}, 'provider' | 'model'>;`,
  `type Fields = Omit<${entry}, 'effort'>;`,
  `type Fields = Readonly<Required<Partial<NonNullable<${entry}>>>>;`,
  `type Fields = Extract<${entry}, { provider: 'claude' }>;`,
  `type Fields = Exclude<${entry}, { provider: 'claude' }>;`,
  `type Fields = ${entry} & ${entry}; type More = ${entry} | Fields;`,
  `type Entries = readonly (${entry})[]; type More = Array<${entry}>;`,
  `type Entry = ${entry}; interface Fields extends Entry {}`,
  `type Fields = { model: ${entry}['model']; provider: ${entry}['provider'] };`,
  `interface Fields { model: ${entry}['model']; provider: ${entry}['provider'] }`,
  `type Body = paths['/api/conversations']['post'];`,
  `import type * as API from '../../../lib/api.generated'; type Entry = API.components['schemas']['TierEntry'];`,
  `import type { QueryParams as Query } from '../lib/api-types'; type Fields = Query<'/api/metrics', 'get'>;`,
  `import type * as API from '../lib/api-types'; type Fields = API.QueryParams<'/api/metrics', 'get'>;`,
  `import type * as API from '@/lib/api.generated'; interface Fields extends API.components {}`,
  `import type * as API from '../../../lib/api.generated'; interface Fields extends API.paths {}`,
  `import type * as API from '../lib/api-types'; interface Fields extends API.QueryParams<'/api/metrics', 'get'> {}`,
  `export type { components } from '@/lib/api.generated';`,
]) {
  test(`accepts generated derivation: ${declaration}`, () => {
    expect(check(declaration)).toEqual([]);
  });
}

test('covers nested sources, tests, TSX and http, while leaving UI owners outside scope', () => {
  const text = 'namespace Inner { interface Independent { id: string } }';
  expect(
    checkSources(
      new Map([
        ['packages/web/src/experiments/console/skills/nested/probe.test.tsx', text],
        ['packages/web/src/experiments/console/lib/http.ts', text],
        ['packages/web/src/experiments/console/primitives/probe.ts', text],
      ])
    )
  ).toEqual([
    expect.stringContaining('nested/probe.test.tsx:1 Independent'),
    expect.stringContaining('lib/http.ts:1 Independent'),
  ]);
});

const trackTempRoot = trackTempRoots();
test('accepts relative generated and helper imports in a separate repository root', () => {
  const root = join(tmpdir(), 'web-api-type-imports');
  expect(
    checkSources(
      new Map([
        [
          file,
          `import type { components } from '../../../lib/api.generated'; type Entry = components['schemas']['TierEntry'];`,
        ],
        [
          'packages/web/src/experiments/console/skills/nested/probe.ts',
          `import type { QueryParams } from '../../lib/api-types'; type Query = QueryParams<'/api/metrics', 'get'>;`,
        ],
      ]),
      root
    )
  ).toEqual([]);
});

test('finds untracked nonignored scoped sources before staging', () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'web-api-type-git-')));
  gitOutput(['init', '--quiet'], root);
  mkdirSync(join(root, 'packages/web/src/experiments/console/skills/nested'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '**/ignored.ts\n');
  writeFileSync(join(root, file), 'export interface Independent { id: string }');
  writeFileSync(
    join(root, 'packages/web/src/experiments/console/skills/nested/probe.test.ts'),
    'type Other = string'
  );
  writeFileSync(
    join(root, 'packages/web/src/experiments/console/skills/ignored.ts'),
    'type Ignored = string'
  );
  expect(gitOutput(['ls-files', '--cached'], root)).toBe('');
  expect(checkRepository(root)).toHaveLength(2);
});
