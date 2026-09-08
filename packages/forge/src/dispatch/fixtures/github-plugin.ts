import { readFileSync } from 'node:fs';
import { createGitHubPlugin } from '../../github/plugin';
const [apiBase, mode, op] = process.argv.slice(2);
const plugin = createGitHubPlugin({ apiBase });
if (mode === 'metadata') {
  process.stdout.write(JSON.stringify(plugin.metadata()));
} else {
  const request: unknown = JSON.parse(readFileSync(0, 'utf8'));
  const result = await plugin.execOp(op, request, process.env);
  process.stdout.write(
    JSON.stringify(
      result.kind === 'ok' ? result.value : result.kind === 'op_error' ? result.raw : result
    )
  );
  process.exitCode = result.kind === 'ok' ? 0 : result.kind === 'op_error' ? 1 : 2;
}
