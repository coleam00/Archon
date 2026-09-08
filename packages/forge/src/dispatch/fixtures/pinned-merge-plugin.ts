import { readFileSync } from 'node:fs';
import { createGitHubPlugin } from '../../github/plugin';
import { execBoundedProcess } from '../exec';
const [apiBase, bare, mode, op] = process.argv.slice(2);
const plugin = createGitHubPlugin({
  apiBase,
  gitExec: (args, options) => {
    const command = Bun.which('git');
    if (!command) throw new Error('Git unavailable');
    const mapped =
      args[0] === 'push'
        ? args.map(arg => (arg === 'https://github.com/owner/repo.git' ? bare : arg))
        : args;
    return execBoundedProcess({ command, args: mapped }, [], options);
  },
});
if (mode === 'metadata') process.stdout.write(JSON.stringify(plugin.metadata()));
else {
  const result = await plugin.execOp(op, JSON.parse(readFileSync(0, 'utf8')), process.env);
  process.stdout.write(
    JSON.stringify(
      result.kind === 'ok' ? result.value : result.kind === 'op_error' ? result.raw : result
    )
  );
  process.exitCode = result.kind === 'ok' ? 0 : result.kind === 'op_error' ? 1 : 2;
}
