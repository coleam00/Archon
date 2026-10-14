import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { gitOutput } from './check-test-cleanup-drift';
import { checkRepository, checkSources, installedSdkTypes } from './check-sdk-type-drift';
import type { SdkTypeException } from './sdk-type-exceptions';

const sdkTypes = installedSdkTypes();
const file = 'packages/example/src/copy.ts';
const sources = new Map([[file, 'export interface OAuthAuthInfo { url: string }']]);
const entry: SdkTypeException = {
  file,
  name: 'OAuthAuthInfo',
  kind: 'independent',
  reason: 'Synthetic fixture for ledger behavior.',
};

test('resolves installed SDK exports, including re-exports and public subpaths', () => {
  expect(sdkTypes.get('SDKMessage')).toContain('@anthropic-ai/claude-agent-sdk');
  expect(sdkTypes.get('OAuthAuthInfo')).toContain('@earendil-works/pi-ai');
  expect(sdkTypes.get('AgentSessionEvent')).toContain('@earendil-works/pi-coding-agent');
  expect(sdkTypes.get('SessionEvent')).toContain('@github/copilot-sdk');
  expect(sdkTypes.get('OpencodeClient')).toContain('@opencode-ai/sdk');
  expect(sdkTypes.has('query')).toBe(false);
});

test('rejects a new same-named SDK type and reports its declaration line', () => {
  expect(checkSources(sources, sdkTypes, [])).toEqual([
    expect.stringContaining(`${file}:1 OAuthAuthInfo matches an exported type`),
  ]);
});

test('ledger entries cover exactly one named declaration', () => {
  expect(checkSources(sources, sdkTypes, [entry])).toEqual([]);
  expect(checkSources(sources, sdkTypes, [])).toHaveLength(1);
  expect(
    checkSources(new Map([[file, 'export interface Renamed { url: string }']]), sdkTypes, [entry])
  ).toEqual([expect.stringContaining('stale SDK type ledger entry')]);
  expect(
    checkSources(
      new Map([
        [file, 'type OAuthAuthInfo = string; namespace Nested { type OAuthAuthInfo = string; }'],
      ]),
      sdkTypes,
      [entry]
    )
  ).toEqual([expect.stringContaining('multiple declarations')]);
});

test('boundary exceptions need an existing conformance test and every entry needs a reason', () => {
  expect(
    checkSources(sources, sdkTypes, [
      { ...entry, kind: 'boundary', conformanceTest: 'scripts/missing.test.ts' },
    ])
  ).toEqual([expect.stringContaining('conformance test does not exist')]);
  expect(checkSources(sources, sdkTypes, [{ ...entry, reason: '' }])).toEqual([
    expect.stringContaining('needs a reason'),
  ]);
  expect(checkSources(sources, sdkTypes, [entry, entry])).toEqual([
    expect.stringContaining('duplicate SDK type ledger entry'),
  ]);
});

test('checks nested interfaces, aliases, TSX and declarations but allows imports and provider sources', () => {
  const text = 'namespace Nested { export type OAuthAuthInfo = string; }';
  expect(
    checkSources(
      new Map([
        ['packages/example/src/copy.tsx', text],
        ['packages/example/src/copy.d.ts', text],
      ]),
      sdkTypes,
      []
    )
  ).toHaveLength(2);
  expect(
    checkSources(
      new Map([
        [
          'packages/example/src/import.ts',
          "import type { OAuthAuthInfo } from '@earendil-works/pi-ai/oauth';",
        ],
        ['packages/providers/src/copy.ts', text],
        ['packages/providers/src/codex/protocol/copy.ts', text],
      ]),
      sdkTypes,
      []
    )
  ).toEqual([]);
});

const trackTempRoot = trackTempRoots();

test("boundary entries cannot use an unrelated existing test or another copy's proof", () => {
  const proof = 'scripts/existing.type-test.ts';
  const boundary = { ...entry, kind: 'boundary' as const, conformanceTest: proof };
  for (const text of [
    "test('unrelated', () => {});",
    "export type BoundaryConformance = { 'another/file.ts:OAuthAuthInfo': never };",
  ]) {
    expect(checkSources(new Map([...sources, [proof, text]]), sdkTypes, [boundary])).toEqual([
      expect.stringContaining('missing conformance proof for'),
    ]);
  }
  expect(
    checkSources(
      new Map([
        ...sources,
        [proof, `export type BoundaryConformance = { '${file}:OAuthAuthInfo': never };`],
      ]),
      sdkTypes,
      [boundary]
    )
  ).toEqual([]);
});

test('repository scan detects an untracked collision before staging', () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'sdk-type-git-')));
  const actual = resolve(import.meta.dir, '..');
  gitOutput(['init', '--quiet'], root);
  mkdirSync(join(root, 'packages/providers'), { recursive: true });
  symlinkSync(join(actual, 'node_modules'), join(root, 'node_modules'), 'junction');
  symlinkSync(
    join(actual, 'packages/providers/node_modules'),
    join(root, 'packages/providers/node_modules'),
    'junction'
  );
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'copy.ts'), 'export interface SDKMessage {}');
  expect(gitOutput(['ls-files', '--cached'], root)).toBe('');
  expect(checkRepository(root)).toContainEqual(
    expect.stringContaining('copy.ts:1 SDKMessage matches an exported type')
  );
});
