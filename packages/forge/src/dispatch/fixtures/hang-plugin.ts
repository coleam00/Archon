#!/usr/bin/env bun
// A plugin whose op call never responds, with a detached grandchild that
// survives an ordinary child kill. Proves the dispatcher's timeout issues a
// real process-TREE termination (POSIX process-group SIGKILL / Windows
// `taskkill /T /F`), not just a kill of the immediate child.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [mode] = process.argv.slice(2);
if (mode === 'metadata') {
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      name: 'hang',
      version: '1.0.0',
      forge: 'example',
      hosts: ['hang.test'],
      capabilities: ['resolve'],
    })
  );
  process.exit(0);
}
if (mode === 'op') {
  const heartbeatFile = process.argv[4];
  if (heartbeatFile) {
    const here = dirname(fileURLToPath(import.meta.url));
    const grandchild = spawn(process.execPath, [join(here, 'heartbeat-writer.ts'), heartbeatFile], {
      detached: process.platform === 'win32',
      stdio: 'ignore',
      env: process.env,
    });
    grandchild.unref();
  }
  await new Promise(() => {
    // Never resolves , the caller's timeout owns ending this process.
  });
}
