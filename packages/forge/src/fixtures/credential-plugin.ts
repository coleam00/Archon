import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const root = args[0] === 'auth' ? process.env.GH_CONFIG_DIR : process.env.HOME;
if (!root) throw new Error('credential fixture has no configuration directory');
if (args[0] === 'auth') {
  appendFileSync(join(root, 'calls'), JSON.stringify(args) + '\n');
  const mode = readFileSync(join(root, 'mode'), 'utf8');
  if (mode === 'error') {
    console.error('secret-from-failing-gh');
    process.exit(4);
  }
  if (mode === 'app' && process.env.GH_TOKEN !== 'ghs_expired')
    throw new Error('App shim did not receive its installation token');
  if (mode === 'empty') process.exit(0);
  console.log('cli-secret');
} else if (args[0] === 'metadata') {
  console.log(
    JSON.stringify({
      protocol: 1,
      name: 'github',
      version: '0.11.1',
      forge: 'github',
      hosts: ['github.com'],
      capabilities: ['pr.view', 'resolve'],
      token_env: existsSync(join(root, 'token-env'))
        ? JSON.parse(readFileSync(join(root, 'token-env'), 'utf8'))
        : ['GITHUB_TOKEN', 'GH_TOKEN'],
    })
  );
} else {
  const request = await Bun.stdin.json();
  if (request.op === 'resolve') {
    console.log(
      JSON.stringify({
        operationId: request.operationId,
        ok: true,
        result: {
          op: 'resolve',
          value: {
            kind: 'resolved',
            forge: 'github',
            repo: { host: 'github.com', path: 'coleam00/Archon' },
            plugin: { name: 'github', version: '0.11.1' },
          },
        },
      })
    );
    process.exit(0);
  }
  const expected = readFileSync(join(root, 'expected'), 'utf8');
  if (expected === 'leak') {
    console.error(process.env.ARCHON_FORGE_TOKEN);
    process.exit(7);
  }
  if (process.env.ARCHON_FORGE_TOKEN !== expected) {
    console.error('wrong credential delivered');
    process.exit(7);
  }
  console.log(
    JSON.stringify({
      operationId: request.operationId,
      ok: true,
      result: { op: 'pr.view', value: null },
    })
  );
}
