import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ITEM_ASKS_DESCRIPTION } from './item-ask';

test('the workflow language reference quotes what the engine tells a model an ask is for', () => {
  const reference = readFileSync(
    join(import.meta.dir, '../../../docs-web/src/content/docs/reference/workflow-language.md'),
    'utf8'
  ).replaceAll('\r\n', '\n'); // `* text=auto` checks the page out with CRLF on Windows
  expect(reference).toContain(`> ${ITEM_ASKS_DESCRIPTION}\n`);
});
