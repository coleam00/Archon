import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, role] = process.argv.slice(2);
if (!dir || !role) throw new Error('Expected fixture directory and role');
const path = join(dir, role);
writeFileSync(`${path}.tmp`, String(process.pid));
renameSync(`${path}.tmp`, path);
if (role === 'child') {
  const child = Bun.spawn([process.execPath, import.meta.path, dir, 'grandchild'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await child.exited;
} else {
  setTimeout(() => writeFileSync(join(dir, 'marker'), 'leaked'), 2500);
  setInterval(() => undefined, 1000);
}
