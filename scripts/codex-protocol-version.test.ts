import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('Codex protocol was generated with the installed SDK version', () => {
  const providers = resolve(import.meta.dir, '../packages/providers');
  const readme = readFileSync(resolve(providers, 'src/codex/protocol/README.md'), 'utf8');
  const stamps = [...readme.matchAll(/^AUTO-GENERATED from `@openai\/codex` (\S+) by /gm)];
  expect(stamps).toHaveLength(1);
  const installed: { version: string } = JSON.parse(
    readFileSync(Bun.resolveSync('@openai/codex/package.json', providers), 'utf8')
  );
  expect(stamps[0][1]).toBe(installed.version);
});
