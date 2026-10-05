import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { commit } from './github-fixture.mjs';
const root = new URL('../dist/plugins/', import.meta.url);
const index = readFileSync(new URL('index.html', root), 'utf8');
for (const id of [
  'test-author/test-pack',
  'test-author/test-pack/packs/second',
  'test-author/archived-forge',
  'test-author/untagged-pack',
]) {
  const page = readFileSync(new URL(`${id}/index.html`, root), 'utf8');
  for (const html of [index, page]) {
    assert.ok(html.includes(`archon plugin install ${id}`));
    assert.ok(html.includes(commit));
    assert.ok(html.includes(id.endsWith('/untagged-pack') ? 'No tags published' : 'v1.0.0'));
    assert.ok(html.includes('Read on GitHub'));
  }
}
assert.ok(!index.includes('test-author/invalid-pack'));
assert.ok(!existsSync(new URL('test-author/invalid-pack/index.html', root)));
assert.ok(index.includes('&lt;script&gt;'));
assert.ok(!index.includes('<script>alert(1)</script>'));
assert.ok(
  readFileSync(new URL('test-author/archived-forge/index.html', root), 'utf8').includes(
    'archon-forge-example'
  )
);
console.log('Mocked plugin index and detail pages passed');
