import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YOUR_CAPABILITIES } from './capabilities';

const DOC_PATH = join(
  import.meta.dir,
  '../../../../docs-web/src/content/docs/contributing/adding-a-community-provider.mdx'
);

describe('community provider capabilities template', () => {
  test('starts with unsupported features and unobserved background work', () => {
    const { backgroundWork, ...features } = YOUR_CAPABILITIES;
    expect(backgroundWork).toBe('unobserved');
    for (const [axis, supported] of Object.entries(features)) {
      expect({ axis, supported }).toEqual({ axis, supported: false });
    }
  });

  test('is rendered by the docs page from this file, not a hand-copied snapshot', () => {
    const page = readFileSync(DOC_PATH, 'utf8');

    expect(page).toContain('community/_template/capabilities.ts?raw');
    expect(page).not.toContain('export const YOUR_CAPABILITIES');
  });
});
