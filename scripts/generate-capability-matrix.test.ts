import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { CODEX_CAPABILITIES } from '../packages/providers/src/codex/capabilities';
import { renderCell } from './generate-capability-matrix';

const track = trackTempRoots();

describe('capability matrix totality', () => {
  test('check rejects optional fields no provider declares', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'capability-matrix-')));
    const preload = join(root, 'extend-schema.ts');
    const schemaPath = resolve(
      import.meta.dir,
      '../packages/provider-contract/src/capabilities.ts'
    );
    writeFileSync(
      preload,
      `import { providerCapabilitiesSchema } from ${JSON.stringify(schemaPath)};
Object.assign(providerCapabilitiesSchema.shape, {
  unsetOptionalCapability: providerCapabilitiesSchema.shape.sessionFork,
  anotherUnsetOptionalCapability: providerCapabilitiesSchema.shape.tokenReporting,
});
`
    );

    const result = Bun.spawnSync(
      [
        process.execPath,
        '--preload',
        preload,
        resolve(import.meta.dir, 'generate-capability-matrix.ts'),
        '--check',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'ProviderCapabilities field(s) not represented in the capability matrix: unsetOptionalCapability, anotherUnsetOptionalCapability.'
    );
  });
});

describe('capability matrix reporting availability', () => {
  test('distinguishes omitted legacy declarations from explicit support and non-support', () => {
    const legacy = { ...CODEX_CAPABILITIES };
    delete legacy.tokenReporting;
    delete legacy.stopReasonReporting;
    delete legacy.turnCountReporting;
    delete legacy.resolvedModelReporting;
    for (const key of [
      'tokenReporting',
      'stopReasonReporting',
      'turnCountReporting',
      'resolvedModelReporting',
    ] as const) {
      expect(renderCell(legacy, key)).toBe('Unknown');
      expect(renderCell({ ...legacy, [key]: false }, key)).toBe('❌');
      expect(renderCell({ ...legacy, [key]: true }, key)).toBe('✅');
    }
    expect(renderCell({ ...legacy, sessionFork: undefined }, 'sessionFork')).toBe('❌');
  });
});
