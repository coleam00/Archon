import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runLiveOwnerPath, startRunLiveOwner } from '@archon/core/services/run-live-owner';

const [runId, root, mode] = process.argv.slice(2);
if (!runId || !root) throw new Error('Missing fixture arguments');
writeFileSync(join(root, 'owner.pid'), String(process.pid));
if (mode === 'live' || mode === 'not-detached') {
  await startRunLiveOwner(runId, mode === 'live' ? { detachedProcessPid: process.pid } : {});
} else {
  const server = createServer(socket => {
    socket.once('data', () => {
      socket.end();
      server.close();
      writeFileSync(join(root, 'closed'), '');
      if (mode === 'exit') socket.once('close', () => process.exit(0));
    });
  });
  await new Promise<void>(resolve => server.listen(runLiveOwnerPath(runId), resolve));
  setInterval(() => undefined, 1000);
}
writeFileSync(join(root, 'ready'), '');
