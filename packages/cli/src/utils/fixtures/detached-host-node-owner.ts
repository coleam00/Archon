import { writeFileSync } from 'node:fs';
import { startRunLiveOwner } from '@archon/core/services/run-live-owner';
import { runSubprocess, endRecordedNodeProcessTrees } from '@archon/workflows/subprocess';
import { registerOwnedRunTermination } from '../owned-run-termination';

const [runId, readyPath, mode] = process.argv.slice(2);
if (!runId || !readyPath) throw new Error('Missing run id or ready path');
if (mode !== 'normal' && mode !== 'survivor' && mode !== 'timeout' && mode !== 'max-buffer') {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
const owner = await startRunLiveOwner(runId, {
  detachedProcessPid: process.pid,
  beforeTerminate: endRecordedNodeProcessTrees,
});
const release = registerOwnedRunTermination({
  runId,
  logModule: 'detached-host-node-owner.test',
  recordLegacyNodes: false,
  liveOwner: owner,
  store: {
    getWorkflowRunStatus: async () => 'running',
    failWorkflowRun: async () => {
      throw new Error('Operator stop must not fail the run');
    },
  },
});
const publishReady = `const fs = require('node:fs');
function ready(pids) {
  fs.writeFileSync(${JSON.stringify(`${readyPath}.tmp`)}, JSON.stringify(pids));
  fs.renameSync(${JSON.stringify(`${readyPath}.tmp`)}, ${JSON.stringify(readyPath)});
}`;
const body =
  mode !== 'normal'
    ? `${publishReady} const { spawn } = require('node:child_process');
     const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');"], { stdio: ['ignore', 'pipe', 'ignore'] });
     child.stdout.once('data', () => {
       ready({ node: process.pid, descendant: child.pid });
       ${mode === 'max-buffer' ? "process.stdout.write('x'.repeat(1024 * 1024 + 1));" : ''}
     });
     process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`
    : `${publishReady} ready({ node: process.pid }); setInterval(() => {}, 1000);`;
void runSubprocess({ kind: 'host' }, process.execPath, ['-e', body], {
  cwd: import.meta.dir,
  timeout: mode === 'timeout' ? 1000 : 60_000,
  env: process.env,
  killTreeOnTimeout: true,
  retention: { standalone: true },
})
  .catch(() => {
    writeFileSync(`${readyPath}.failed`, '');
  })
  .finally(() => {
    if (mode === 'normal' || mode === 'survivor') release();
  });
setInterval(() => undefined, 1000);
