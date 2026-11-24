import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  factoryOverviewIconSchema,
  factoryOverviewKindSchema,
  factoryOverviewSchema,
} from './factory-overview';

// `* text=auto` checks the guide out with CRLF on Windows.
const guide = readFileSync(
  join(import.meta.dir, '../../../docs-web/src/content/docs/guides/factory-console.md'),
  'utf8'
).replaceAll('\r\n', '\n');

/** The guide's text under `## <title>`, up to the next `## ` heading. */
function section(title: string): string {
  return guide.split(`\n## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
}

test("the factory console guide's overview example is a valid factory overview", () => {
  const block = /```json\n([\s\S]*?)\n```/.exec(section('Overview example'))?.[1];
  expect(block).toBeDefined();
  const parsed = factoryOverviewSchema.safeParse(JSON.parse(block ?? ''));
  expect(parsed.error?.issues ?? []).toEqual([]);
});

test("the guide's overview fields table lists exactly the overview's fields", () => {
  const fields = [...section('Overview fields').matchAll(/^\| `([A-Za-z_]+)` \|/gm)].map(
    match => match[1]
  );
  expect(fields.sort()).toEqual(Object.keys(factoryOverviewSchema.shape).sort());
});

test('the guide names exactly the icons and card kinds the schema allows', () => {
  const fields = section('Overview fields');
  const icons = /The icons are ([^.]*)\./.exec(fields)?.[1] ?? '';
  expect([...icons.matchAll(/`([a-z-]+)`/g)].map(match => match[1])).toEqual([
    ...factoryOverviewIconSchema.options,
  ]);
  const kinds = /a `kind` \((.*?)\)/.exec(fields)?.[1] ?? '';
  expect([...kinds.matchAll(/`([a-z-]+)`/g)].map(match => match[1])).toEqual([
    ...factoryOverviewKindSchema.options,
  ]);
});
