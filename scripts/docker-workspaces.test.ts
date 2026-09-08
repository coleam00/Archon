import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const manifest = (path: string): { name: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const packages = [...new Bun.Glob('packages/*/package.json').scanSync(root)];
const byName = new Map(packages.map(path => [manifest(path).name, path]));
const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');

test('each Docker install stage includes every workspace manifest', () => {
  const stages = dockerfile.split(/^FROM /m).filter(stage => stage.includes('bun install'));
  expect(stages).toHaveLength(2);
  for (const stage of stages) {
    const sources = [...stage.matchAll(/^COPY (?:--\S+ )*(\S+) /gm)].map(match => match[1]);
    for (const path of packages) expect(sources).toContain(path.replaceAll('\\', '/'));
  }
});

test('the production image copies the sources of every runtime workspace dependency', () => {
  const production = dockerfile.split(' AS production')[1];
  expect(production).toBeDefined();
  const sources = [...production.matchAll(/^COPY (?:--\S+ )*(\S+) /gm)].map(match => match[1]);
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    if (path !== 'package.json') {
      expect(sources).toContain(path.replaceAll('\\', '/').replace('package.json', ''));
    }
    for (const [name, version] of Object.entries(manifest(path).dependencies ?? {})) {
      if (!version.startsWith('workspace:')) continue;
      const dependency = byName.get(name);
      if (!dependency) throw new Error('Missing workspace: ' + name);
      visit(dependency);
    }
  };
  // The image entrypoint starts the server and setup-auth; workflows re-enter CLI.
  for (const path of [
    'package.json',
    'packages/server/package.json',
    'packages/cli/package.json',
  ]) {
    visit(path);
  }
});
