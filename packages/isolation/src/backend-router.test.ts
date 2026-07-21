import { describe, test, expect } from 'bun:test';
import { resolveFolderBackend } from './backend-router';
import { InPlaceBackend } from './backends/in-place';
import { ContainerBackend } from './backends/container';
import type { ContainerBackendConfig } from './types';
import type { IIsolationStore } from './store';

const folderCodebase = {
  id: 'cb-folder',
  defaultCwd: '/tmp/platform',
  name: 'platform',
  kind: 'folder' as const,
};

const containerConfig: ContainerBackendConfig = {
  image: 'archon-runner:test',
  network: 'bridge',
  memoryMb: 4096,
  pidsLimit: 512,
};

// Minimal store stub — resolveFolderBackend only stores the reference; it never
// calls the store (that happens in ContainerBackend.prepare).
const stubStore = {} as IIsolationStore;

const repoCodebase = {
  id: 'cb-repo',
  defaultCwd: '/repos/myrepo',
  name: 'owner/repo',
  kind: 'repo' as const,
};

describe('resolveFolderBackend', () => {
  test('folder codebase → in-place backend by default', () => {
    const backend = resolveFolderBackend(folderCodebase);
    expect(backend).toBeInstanceOf(InPlaceBackend);
    expect(backend.id).toBe('in-place');
  });

  test('folder codebase with { container: false } → in-place backend', () => {
    const backend = resolveFolderBackend(folderCodebase, { container: false });
    expect(backend.id).toBe('in-place');
  });

  test('repo codebase → throws (the seam is folder-only)', () => {
    expect(() => resolveFolderBackend(repoCodebase)).toThrow(/folder-only/);
  });

  test('container requested with store + config → container backend', () => {
    const backend = resolveFolderBackend(folderCodebase, {
      container: true,
      store: stubStore,
      containerConfig,
    });
    expect(backend).toBeInstanceOf(ContainerBackend);
    expect(backend.id).toBe('container');
  });

  test('container requested WITHOUT store/config → throws (no silent host downgrade)', () => {
    expect(() => resolveFolderBackend(folderCodebase, { container: true })).toThrow(/not wired up/);
    // Missing containerConfig (store present).
    expect(() =>
      resolveFolderBackend(folderCodebase, { container: true, store: stubStore })
    ).toThrow(/not wired up/);
    // Missing store (containerConfig present) — asserted independently so removing
    // the store validation alone would be caught.
    expect(() =>
      resolveFolderBackend(folderCodebase, { container: true, containerConfig })
    ).toThrow(/not wired up/);
  });

  test('repo codebase + container → throws (seam is folder-only, checked first)', () => {
    expect(() =>
      resolveFolderBackend(repoCodebase, { container: true, store: stubStore, containerConfig })
    ).toThrow(/folder-only/);
  });
});
