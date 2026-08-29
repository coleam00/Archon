import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const RELEASE_WORKFLOW = join(import.meta.dir, '..', '.github', 'workflows', 'release.yml');
const RELEASE_ARTIFACTS = [
  'archon-darwin-arm64',
  'archon-darwin-x64',
  'archon-linux-arm64',
  'archon-linux-x64',
  'archon-windows-x64.exe',
  'archon-web.tar.gz',
];
const trackTempRoot = trackTempRoots();

function checksumCommand(): string {
  const workflow = Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, 'utf8')) as {
    jobs: { release: { steps: Array<{ name?: string; run?: string }> } };
  };
  const command = workflow.jobs.release.steps.find(step => step.name === 'Generate checksums')?.run;
  if (command === undefined) throw new Error('Release workflow has no checksum generation command');
  return command;
}

test('release checksum command lists every released artifact exactly once (#2377)', () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'release-checksums-')));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  for (const artifact of RELEASE_ARTIFACTS) writeFileSync(join(dist, artifact), artifact);

  const result = Bun.spawnSync(['bash', '-c', checksumCommand()], { cwd: root });
  expect(result.exitCode).toBe(0);

  const filenames = readFileSync(join(dist, 'checksums.txt'), 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const match = /^([a-f\d]{64})  (.+)$/.exec(line);
      if (match === null) throw new Error(`Malformed checksum row: ${line}`);
      return match[2];
    });

  expect([...filenames].sort()).toEqual([...RELEASE_ARTIFACTS].sort());
  expect(new Set(filenames).size).toBe(RELEASE_ARTIFACTS.length);
});
