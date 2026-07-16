import { describe, test, expect } from 'bun:test';
import { resolveFolderBackend } from './backend-router';
import { InPlaceBackend } from './backends/in-place';

const folderCodebase = {
  id: 'cb-folder',
  defaultCwd: '/tmp/platform',
  name: 'platform',
  kind: 'folder' as const,
};

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

  test('container requested → throws (not available until Phase B, no silent downgrade)', () => {
    expect(() => resolveFolderBackend(folderCodebase, { container: true })).toThrow(
      /not available/
    );
  });
});
