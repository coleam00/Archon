// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  loadResourceConcurrencyCaps,
  ResourceConcurrencyConfigError,
} from './resource-concurrency';

let root: string;
let previousHome: string | undefined;
beforeEach(async () => {
  previousHome = process.env.ARCHON_HOME;
  root = await mkdtemp(join(tmpdir(), 'archon-resource-config-'));
  process.env.ARCHON_HOME = root;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  await removeTempTree(root);
});

const configure = async (content: string): Promise<void> => {
  await writeFile(join(root, 'config.yaml'), content);
};

describe('install resource concurrency', () => {
  test('reads edits and removal fresh without retaining the last capacity', async () => {
    expect(await loadResourceConcurrencyCaps()).toEqual(new Map());
    await configure('concurrency:\n  resources: { build: 2, merge: 1 }\n');
    expect(await loadResourceConcurrencyCaps()).toEqual(
      new Map([
        ['build', 2],
        ['merge', 1],
      ])
    );
    await configure('concurrency:\n  resources: { build: 3 }\n');
    expect(await loadResourceConcurrencyCaps()).toEqual(new Map([['build', 3]]));
    await configure('concurrency:\n  resources: { build: 1 }\n');
    expect(await loadResourceConcurrencyCaps()).toEqual(new Map([['build', 1]]));
    await configure('concurrency:\n  maxConversations: 5\n');
    expect(await loadResourceConcurrencyCaps()).toEqual(new Map());
  });

  test('leaves unrelated settings and provider caps to their own readers', async () => {
    await configure(
      'concurrency:\n  providers: { custom-provider: 4 }\n  resources: { custom-resource: 7 }\nassistants:\n  pi:\n    maxConcurrent: 2\n'
    );
    expect(await loadResourceConcurrencyCaps()).toEqual(new Map([['custom-resource', 7]]));
    for (const content of ['', 'concurrency:', 'concurrency:\n  resources:']) {
      await configure(content);
      expect(await loadResourceConcurrencyCaps()).toEqual(new Map());
    }
  });

  test('refuses damaged config and invalid limits with the file and key named', async () => {
    for (const value of ['0', '-1', '1.5', '"3"', 'false', '{}']) {
      await configure(`concurrency:\n  resources: { build: ${value} }\n`);
      await expect(loadResourceConcurrencyCaps()).rejects.toThrow('concurrency.resources.build');
    }
    for (const content of [
      'concurrency: []',
      'concurrency:\n  resources: []',
      'concurrency:\n  resources: { provider:claude: 1 }',
      'concurrency: [',
    ]) {
      await configure(content);
      await expect(loadResourceConcurrencyCaps()).rejects.toBeInstanceOf(
        ResourceConcurrencyConfigError
      );
      await expect(loadResourceConcurrencyCaps()).rejects.toThrow(join(root, 'config.yaml'));
    }
  });

  test('reports a config file that cannot be read instead of treating it as absent', async () => {
    await mkdir(join(root, 'config.yaml'));
    await expect(loadResourceConcurrencyCaps()).rejects.toBeInstanceOf(
      ResourceConcurrencyConfigError
    );
  });
});
