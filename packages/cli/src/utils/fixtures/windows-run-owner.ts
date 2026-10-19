import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRunLiveOwner } from '@archon/core/services/run-live-owner';
import { assertDetachedRunProcessOwner } from '../detached-run-control';

/*
 * A real detached run owner for the Windows stop tests. Every process it starts carries
 * `<dir>` on its command line, so the spec can find survivors by it.
 *
 * - `orphan`: start an intermediate that starts a detached grandchild and exits, so the
 *   grandchild's parent is gone before any stop begins.
 * - `spawner`: start a detached child every few milliseconds, so a stop races a spawn.
 */

const [runId, dir, mode] = process.argv.slice(2);
if (!runId || !dir || (mode !== 'orphan' && mode !== 'spawner')) {
  throw new Error('Usage: windows-run-owner.ts <run-id> <dir> <orphan|spawner>');
}

assertDetachedRunProcessOwner();
await startRunLiveOwner(runId, { detachedProcessPid: process.pid });

const idle = 'setInterval(() => undefined, 1000);';

function writeReady(): void {
  // Written aside and renamed into place: the spec reads the file as soon as it exists.
  const readyPath = join(dir, 'ready');
  writeFileSync(`${readyPath}.tmp`, String(process.pid));
  renameSync(`${readyPath}.tmp`, readyPath);
}

if (mode === 'orphan') {
  const intermediate = spawn(
    process.execPath,
    [
      '-e',
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const dir = process.argv[1];',
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(idle)}, dir], { detached: true, stdio: 'ignore' });`,
        "fs.writeFileSync(path.join(dir, 'grandchild'), String(child.pid));",
        'process.exit(0);',
      ].join('\n'),
      dir,
    ],
    { stdio: 'ignore' }
  );
  intermediate.on('error', error => {
    throw error;
  });
  intermediate.once('exit', writeReady);
} else {
  const kidsDir = join(dir, 'kids');
  const loop = (): void => {
    const child = spawn(process.execPath, ['-e', idle, dir], { detached: true, stdio: 'ignore' });
    writeFileSync(join(kidsDir, String(child.pid)), '');
    setTimeout(loop, 10);
  };
  mkdirSync(kidsDir);
  loop();
  writeReady();
}

setInterval(() => undefined, 1_000);
