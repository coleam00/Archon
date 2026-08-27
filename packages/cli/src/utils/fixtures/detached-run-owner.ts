import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  assertDetachedRunProcessOwner,
  startDetachedRunControlServer,
} from '../detached-run-control';

const [runId, readyPath, leakPath, goPath] = process.argv.slice(2);
if (!runId || !readyPath || !leakPath || !goPath) {
  throw new Error('Usage: detached-run-owner.ts <run-id> <ready-path> <leak-path> <go-path>');
}

assertDetachedRunProcessOwner();

// The descendant leaks work only when an external go signal appears. The spec
// decides whether that signal can exist, so a correct process-group kill ends
// the descendant before any signal is ever written; no wall-clock race remains.
const leakWriter = spawn(
  process.execPath,
  [
    '-e',
    [
      "const fs = require('node:fs');",
      'const timer = setInterval(() => {',
      `  if (!fs.existsSync(${JSON.stringify(goPath)})) return;`,
      '  clearInterval(timer);',
      `  fs.writeFileSync(${JSON.stringify(leakPath)}, 'leaked');`,
      '}, 25);',
    ].join(''),
  ],
  { stdio: 'ignore' }
);
leakWriter.on('error', error => {
  throw error;
});

await startDetachedRunControlServer(runId);
writeFileSync(readyPath, JSON.stringify({ owner: process.pid, leakWriter: leakWriter.pid }));
setInterval(() => undefined, 1_000);
