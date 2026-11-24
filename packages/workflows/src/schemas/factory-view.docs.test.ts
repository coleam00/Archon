import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryDrilldownIconSchema, factoryViewSchema } from './factory-view';

// `* text=auto` checks the guide out with CRLF on Windows.
const guide = readFileSync(
  join(import.meta.dir, '../../../docs-web/src/content/docs/guides/factory-console.md'),
  'utf8'
).replaceAll('\r\n', '\n');

/** The guide's text under `## <title>`, up to the next `## ` heading. */
function section(title: string): string {
  return guide.split(`\n## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
}

test("the factory console guide's example is a valid factory view", () => {
  const block = /```json\n([\s\S]*?)\n```/.exec(section('Example'))?.[1];
  expect(block).toBeDefined();
  const parsed = factoryViewSchema.safeParse(JSON.parse(block ?? ''));
  expect(parsed.error?.issues ?? []).toEqual([]);
});

test("the guide's fields table lists exactly the declaration's fields", () => {
  const fields = [...section('Fields').matchAll(/^\| `([A-Za-z]+)` \|/gm)].map(match => match[1]);
  expect(fields.sort()).toEqual(Object.keys(factoryViewSchema.shape).sort());
});

test('the guide names exactly the icons a drill-down card may show', () => {
  const icons = /an `icon` \(one of ([^)]*)\)/.exec(section('Fields'))?.[1] ?? '';
  expect([...icons.matchAll(/`([a-z-]+)`/g)].map(match => match[1])).toEqual([
    ...factoryDrilldownIconSchema.options,
  ]);
});
