import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';

const track = trackTempRoots();
const SCRIPT = join(import.meta.dir, '../../workflows/sdlc/cleanup/scripts/merged.ts');

async function runMerged(includeClosed: string, exitCode = 0) {
  const dir = track(await mkdtemp(join(tmpdir(), 'worktree-cleanup-')));
  const cli = join(dir, 'archon.ts');
  writeFileSync(
    cli,
    `console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = ${String(exitCode)};`
  );
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      INPUTS_INCLUDE_CLOSED: includeClosed,
      ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, cli]),
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

describe('archon-worktree-cleanup merged', () => {
  it.each([
    ['false', ['isolation', 'cleanup', '--merged']],
    ['true', ['isolation', 'cleanup', '--merged', '--include-closed']],
  ])('include_closed %s runs the host CLI merged cleanup', async (includeClosed, argv) => {
    const result = await runMerged(includeClosed);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(argv);
  });

  it('fails the node when the CLI fails', async () => {
    expect((await runMerged('false', 3)).status).toBe(3);
  });

  it('refuses any other include_closed value without running the CLI', async () => {
    const result = await runMerged('yes');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('include_closed must be "true" or "false"');
  });
});
