import { join } from 'node:path';
import { forgeCommand } from '../forge';
const [apiBase, ...args] = process.argv.slice(2);
if (args[0] === 'forge') args.shift();
process.exitCode = await forgeCommand(args, {
  source: 'fixture:github',
  command: process.execPath,
  args: [
    join(import.meta.dir, '../../../../forge/src/dispatch/fixtures/github-plugin.ts'),
    apiBase,
  ],
});
