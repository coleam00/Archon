import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDatabase } from '@archon/core/db/connection';
import { setLogSink } from '@archon/paths';
import { startServer } from '../../index';

const root = process.argv[2];
if (!root) throw new Error('Usage: setup-shutdown-server.ts <root>');

await getDatabase().query(
  "INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Setup shutdown test')",
  ['22222222-2222-4222-8222-222222222222']
);

let port: number | undefined;
setLogSink(line => {
  process.stdout.write(line);
  const event: unknown = JSON.parse(line);
  if (
    typeof event === 'object' &&
    event !== null &&
    'msg' in event &&
    event.msg === 'server_listening' &&
    'port' in event &&
    typeof event.port === 'number'
  )
    port = event.port;
});
await startServer({ skipPlatformAdapters: true, port: 0 });
if (port === undefined) throw new Error('Server did not report its bound port');
// The test treats the file's existence as readiness, so it must appear already complete.
await writeFile(join(root, 'server.port.tmp'), String(port));
await rename(join(root, 'server.port.tmp'), join(root, 'server.port'));
