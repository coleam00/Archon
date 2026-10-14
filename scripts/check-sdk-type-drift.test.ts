import { expect, test } from 'bun:test';
import { checkSources, installedSdkTypes } from './check-sdk-type-drift';
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
