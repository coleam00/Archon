import { trackTempRoots } from '@archon/paths/test-utils';
const track = trackTempRoots();
import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPathPlugins } from './discovery';
async function makeCandidateFile(dir: string, name: string, executable: boolean): Promise<string> {
  const full = join(dir, name);
  await writeFile(full, '#!/bin/sh\necho hi\n');
  if (process.platform !== 'win32' && executable) await chmod(full, 0o755);
  if (process.platform !== 'win32' && !executable) await chmod(full, 0o644);
  return full;
}
describe('discoverPathPlugins , real filesystem', () => {
  it('finds an archon-forge-* candidate on PATH with the platform-correct shape', async () => {
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-discovery-')));
    const fileName =
      process.platform === 'win32' ? 'archon-forge-gitlab.exe' : 'archon-forge-gitlab';
    await makeCandidateFile(dir, fileName, true);
    const found = await discoverPathPlugins(dir);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('PATH:gitlab');
  });
  it('ignores a non-matching filename', async () => {
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-discovery-')));
    const fileName = process.platform === 'win32' ? 'some-other-tool.exe' : 'some-other-tool';
    await makeCandidateFile(dir, fileName, true);
    const found = await discoverPathPlugins(dir);
    expect(found).toHaveLength(0);
  });
  it('is case-insensitive on Windows and matches only the .exe shape', async () => {
    if (process.platform !== 'win32') return;
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-discovery-')));
    await makeCandidateFile(dir, 'ARCHON-FORGE-Gitea.EXE', true);
    await makeCandidateFile(dir, 'archon-forge-legacy.cmd', true);
    await makeCandidateFile(dir, 'archon-forge-legacy.bat', true);
    const found = await discoverPathPlugins(dir);
    const names = found.map(f => f.source);
    expect(names).toContain('PATH:gitea');
    expect(names.some(n => n.includes('legacy'))).toBe(false);
  });
  it('requires the POSIX executable bit and skips a non-executable match', async () => {
    if (process.platform === 'win32') return;
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-discovery-')));
    await makeCandidateFile(dir, 'archon-forge-gitea', false);
    const found = await discoverPathPlugins(dir);
    expect(found).toHaveLength(0);
  });
  it('discovers duplicate names so handshake can refuse ambiguous hosts', async () => {
    const dirA = track(await mkdtemp(join(tmpdir(), 'forge-discovery-a-')));
    const dirB = track(await mkdtemp(join(tmpdir(), 'forge-discovery-b-')));
    const fileName = process.platform === 'win32' ? 'archon-forge-gitea.exe' : 'archon-forge-gitea';
    const fileA = await makeCandidateFile(dirA, fileName, true);
    await makeCandidateFile(dirB, fileName, true);
    const separator = process.platform === 'win32' ? ';' : ':';
    const found = await discoverPathPlugins(`${dirA}${separator}${dirB}`);
    expect(found).toHaveLength(2);
    expect(found[0].command).toBe(fileA);
  });
  it('does not descend into subdirectories', async () => {
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-discovery-')));
    const subdir = join(dir, 'archon-forge-nested');
    await mkdir(subdir);
    const found = await discoverPathPlugins(dir);
    expect(found).toHaveLength(0);
  });
  it('returns empty for a PATH entry that does not exist', async () => {
    const found = await discoverPathPlugins(
      join(tmpdir(), `forge-discovery-missing-${String(Date.now())}`)
    );
    expect(found).toHaveLength(0);
  });
});
