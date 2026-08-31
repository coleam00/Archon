import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `* text=auto` checks this workflow out with CRLF on Windows CI. Normalizing here lets every
// pattern below anchor on LF, so a stray `\r` can never reach a capture.
const workflow = readFileSync(
  resolve(import.meta.dir, '../.github/workflows/publish.yml'),
  'utf8'
).replace(/\r\n/g, '\n');

test('publish workflow triggers only on tag pushes and manual dispatch', () => {
  // Must trigger on tag push matching v* so Docker images build alongside release binaries.
  expect(workflow).toMatch(/^ {2}push:\n {4}tags:\n {6}- ['"]v\*['"]/m);
  // Must support manual re-publishing.
  expect(workflow).toMatch(/^ {2}workflow_dispatch:/m);
  // Must NOT trigger on release: [published] to prevent duplicate execution (#3012).
  expect(workflow).not.toMatch(/^ {2}release:/m);
  expect(workflow).not.toMatch(/types:\s*\[published\]/);
});

test('publish workflow configures concurrency with cancel-in-progress false', () => {
  // Concurrency group prevents overlapping runs for the same ref without aborting
  // in-flight multi-platform builds.
  expect(workflow).toMatch(
    /^concurrency:\n {2}group: publish-\${{\s*github\.ref\s*}}\n {2}cancel-in-progress: false/m
  );
});

test('publish workflow preserves docker metadata tag definitions and flavor', () => {
  expect(workflow).toContain('type=semver,pattern={{version}}');
  expect(workflow).toContain('type=semver,pattern={{major}}.{{minor}}');
  expect(workflow).toContain('type=semver,pattern={{major}}');
  expect(workflow).toContain('type=sha');
  expect(workflow).toContain(
    "type=raw,value=latest,enable=${{ github.ref == format('refs/heads/{0}', 'main') }}"
  );
  expect(workflow).toContain('latest=auto');
});

test('publish workflow targets multi-platform build on ubuntu-latest', () => {
  expect(workflow).toMatch(/runs-on:\s*ubuntu-latest/);
  expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
  expect(workflow).toContain('push: true');
});
