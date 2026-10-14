import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const page = readSource('./content/docs/reference/architecture.md');
const example = page.split('**Webhooks** (GitHub pattern):')[1]?.split('\n**Reference:**')[0];
const blocks = [...(example ?? '').matchAll(/```typescript\n([\s\S]*?)\n```/g)].map(
  match => match[1]
);

test('the architecture webhook route quotes the current server route', () => {
  const routes = readSource('../../server/src/routes/webhooks.ts');
  const route = routes.match(/^export function registerGithubWebhookRoute\([\s\S]*?^\}/m)?.[0];

  expect(blocks).toHaveLength(2);
  if (route === undefined) throw new Error('Could not find registerGithubWebhookRoute in source');
  expect(blocks[0]).toBe(route);
});

test('the architecture webhook registration quotes the current server registration', () => {
  const server = readSource('../../server/src/index.ts');
  const importLine = server.match(/^import \{[^\n]*registerGithubWebhookRoute[^\n]*$/m)?.[0];
  const registration = server.match(/^  if \(github\) \{\n[\s\S]*?^  \}/m)?.[0];

  expect(importLine).toBeDefined();
  expect(registration).toBeDefined();
  expect(blocks[1]).toBe(`${importLine}\n\n${registration?.replace(/^  /gm, '')}`);
});
