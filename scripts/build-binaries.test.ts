import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const script = resolve(import.meta.dir, 'build-binaries.sh');

function runBuild(
  failServer = false,
  target = 'bun-linux-x64',
  outfile = 'dist/archon-linux-x64'
): { exitCode: number; output: string; builds: string[] } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-binary-build-')));
  mkdirSync(join(root, 'packages/paths/src'), { recursive: true });
  mkdirSync(join(root, 'dist'));
  copyFileSync(
    resolve(import.meta.dir, '../packages/paths/src/server-launch.ts'),
    join(root, 'packages/paths/src/server-launch.ts')
  );
  copyFileSync(
    resolve(import.meta.dir, '../packages/paths/src/release-asset.ts'),
    join(root, 'packages/paths/src/release-asset.ts')
  );
  writeFileSync(join(root, 'archon-web.tar.gz'), 'web fixture');
  // Shell functions intercept compilation; this test never invokes the Bun compiler.
  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      `
      bun() {
        if [ "$1" = 'run' ]; then return 0; fi
        if [ "$1" = '-e' ]; then "$BUILD_TEST_BUN" "$@"; return $?; fi
        [ "$1" = 'build' ] || return 90
        printf '%s\\n' "$*" >> builds.txt
        cat packages/paths/src/bundled-build.ts >> constants.txt
        if [ "$FAIL_SERVER" = 'true' ]; then return 42; fi
        for arg in "$@"; do
          case "$arg" in --outfile=*) output="\${arg#--outfile=}" ;; esac
        done
        dd if=/dev/zero of="$output" bs=1 count=1 seek=1000000 2>/dev/null
      }
      git() { return 0; }
      export -f bun git
      bash "$BUILD_SCRIPT"
    `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        VERSION: '1.2.3',
        GIT_COMMIT: 'abcdef12',
        TARGET: target,
        OUTFILE: outfile,
        BUILD_TEST_BUN: process.execPath,
        BUILD_SCRIPT: script,
        FAIL_SERVER: String(failServer),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const constants = readFileSync(join(root, 'constants.txt'), 'utf8');
  expect(constants.match(/BUNDLED_VERSION = '1.2.3'/g)).toHaveLength(failServer ? 1 : 2);
  expect(constants.match(/BUNDLED_GIT_COMMIT = 'abcdef12'/g)).toHaveLength(failServer ? 1 : 2);
  expect(constants).toContain('BUNDLED_IS_BINARY = true');
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    builds: readFileSync(join(root, 'builds.txt'), 'utf8').trim().split('\n'),
  };
}

test('binary script builds server before CLI with the same constants, target and minification', () => {
  const result = runBuild();
  expect(result.exitCode).toBe(0);
  expect(result.builds).toEqual([
    'build --compile --minify --target=bun-linux-x64 --outfile=dist/archon-server-linux-x64 packages/server/src/bin.ts',
    'build --compile --minify --target=bun-linux-x64 --outfile=dist/archon-linux-x64 packages/cli/src/cli.ts',
  ]);
});

test('Windows server output is derived beside the CLI output with its executable suffix', () => {
  const result = runBuild(false, 'bun-windows-x64', 'dist/archon-windows-x64.exe');
  expect(result.exitCode).toBe(0);
  expect(result.builds).toEqual([
    'build --compile --minify --target=bun-windows-x64 --outfile=dist/archon-server-windows-x64.exe packages/server/src/bin.ts',
    'build --compile --minify --target=bun-windows-x64 --outfile=dist/archon-windows-x64.exe packages/cli/src/cli.ts',
  ]);
});

test('server build failure stops the release before building the CLI', () => {
  const result = runBuild(true);
  expect(result.exitCode).toBe(42);
  expect(result.builds).toHaveLength(1);
  expect(result.builds[0]).toContain('packages/server/src/bin.ts');
});
