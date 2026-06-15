import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { customProviderApiKeyEnvVar } from './custom-provider-key';

const created: string[] = [];

function modelsDir(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-models-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify(contents));
  created.push(dir);
  return dir;
}

describe('customProviderApiKeyEnvVar', () => {
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('resolves a "$ENV" apiKey reference to the bare env-var name', () => {
    const dir = modelsDir({
      providers: { tiepoint: { apiKey: '$TIEPOINT_AI_GATEWAY_KEY' } },
    });
    expect(customProviderApiKeyEnvVar('tiepoint', dir)).toBe('TIEPOINT_AI_GATEWAY_KEY');
  });

  test('returns undefined for a literal (non-"$") apiKey', () => {
    const dir = modelsDir({ providers: { foo: { apiKey: 'sk-literal-value' } } });
    expect(customProviderApiKeyEnvVar('foo', dir)).toBeUndefined();
  });

  test('returns undefined when the provider is not present', () => {
    const dir = modelsDir({ providers: {} });
    expect(customProviderApiKeyEnvVar('missing', dir)).toBeUndefined();
  });

  test('returns undefined when models.json does not exist', () => {
    expect(
      customProviderApiKeyEnvVar('x', join(tmpdir(), 'pi-nonexistent-dir-xyz'))
    ).toBeUndefined();
  });

  test('returns undefined on malformed models.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-bad-'));
    writeFileSync(join(dir, 'models.json'), '{ not valid json');
    created.push(dir);
    expect(customProviderApiKeyEnvVar('x', dir)).toBeUndefined();
  });

  test('returns undefined for a bare "$" with no name', () => {
    const dir = modelsDir({ providers: { foo: { apiKey: '$' } } });
    expect(customProviderApiKeyEnvVar('foo', dir)).toBeUndefined();
  });
});
