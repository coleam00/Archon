import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { runLiveOwnerPath, startRunLiveOwner } from '@archon/core/services/run-live-owner';

const [runId, mode, pidFile, readyFile, closedFile] = process.argv.slice(2);
if (!runId || !mode || !pidFile || !readyFile || !closedFile)
  throw new Error('Missing fixture arguments');
writeFileSync(pidFile, String(process.pid));
if (mode === 'live' || mode === 'not-detached') {
  await startRunLiveOwner(runId, mode === 'live' ? { detachedProcessPid: process.pid } : {});
} else {
  const server = createServer(socket => {
    socket.once('data', () => {
      socket.end();
      server.close();
      writeFileSync(closedFile, '');
      if (mode === 'exit') socket.once('close', () => process.exit(0));
    });
  });
  await new Promise<void>(resolve => server.listen(runLiveOwnerPath(runId), resolve));
  setInterval(() => undefined, 1000);
}
writeFileSync(readyFile, '');
