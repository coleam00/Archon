import { describe, test, expect } from 'bun:test';
import { remapContainerPath, type ContainerPathMap } from './types';

// The worktree lives in the WSL distro (POSIX path); the run meta dir is a host
// (win32) path bind-mounted at /archon-meta. A single pathMap remaps both, so a
// container whose mounts don't sit at the host cwd resolves every forwarded path.
const MAP: ContainerPathMap = [
  { hostPrefix: '/home/bunny/archon/worktrees/marphob-page/s1', containerPrefix: '/work' },
  {
    hostPrefix: 'C:\\Users\\Buun\\.archon\\workspaces\\buun-dev\\marphob-page',
    containerPrefix: '/archon-meta',
  },
];

describe('remapContainerPath', () => {
  test('returns the value unchanged when no pathMap is given', () => {
    expect(remapContainerPath('/work/foo', undefined)).toBe('/work/foo');
  });

  test('remaps an exact host worktree prefix to the container mount', () => {
    expect(remapContainerPath('/home/bunny/archon/worktrees/marphob-page/s1', MAP)).toBe('/work');
  });

  test('remaps a path under the worktree prefix, preserving the suffix', () => {
    expect(remapContainerPath('/home/bunny/archon/worktrees/marphob-page/s1/docs', MAP)).toBe(
      '/work/docs'
    );
  });

  test('remaps a win32 host meta prefix to /archon-meta, normalizing separators', () => {
    expect(
      remapContainerPath(
        'C:\\Users\\Buun\\.archon\\workspaces\\buun-dev\\marphob-page\\artifacts\\runs\\r1',
        MAP
      )
    ).toBe('/archon-meta/artifacts/runs/r1');
  });

  test('is boundary-safe — a partial prefix like /work does not swallow /workspace', () => {
    const map: ContainerPathMap = [{ hostPrefix: '/work', containerPrefix: '/x' }];
    expect(remapContainerPath('/workspace/foo', map)).toBe('/workspace/foo');
  });

  test('passes through a value outside every host prefix', () => {
    expect(remapContainerPath('/etc/hosts', MAP)).toBe('/etc/hosts');
  });

  test('leaves an empty value untouched', () => {
    expect(remapContainerPath('', MAP)).toBe('');
  });
});
