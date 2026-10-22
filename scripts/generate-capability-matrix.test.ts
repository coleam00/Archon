import { describe, expect, test } from 'bun:test';
import { providerCapabilitiesSchema } from '../packages/provider-contract/src/capabilities';
import { CODEX_CAPABILITIES } from '../packages/providers/src/codex/capabilities';
import { assertTotalCoverage, renderCell } from './generate-capability-matrix';

describe('capability matrix totality', () => {
  test('covers every current schema field with an axis or explicit skip', () => {
    expect(() => assertTotalCoverage()).not.toThrow();
  });

  test('rejects optional schema fields that no provider declares', () => {
    const extended = providerCapabilitiesSchema.extend({
      unsetOptionalCapability: providerCapabilitiesSchema.shape.sessionFork,
      anotherUnsetOptionalCapability: providerCapabilitiesSchema.shape.tokenReporting,
    });

    expect(() => assertTotalCoverage(extended.shape)).toThrow(
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
