import { readFileSync } from 'node:fs';
import { FORGE_PROTOCOL_VERSION, PUBLIC_OPS } from '../../protocol';

const [endpoint, mode, op] = process.argv.slice(2);
if (mode === 'metadata') {
  process.stdout.write(
    JSON.stringify({
      protocol: FORGE_PROTOCOL_VERSION,
      name: 'public-http-fixture',
      version: '1.0.0',
      forge: 'fixture',
      hosts: ['fixture.test'],
      capabilities: Object.values(PUBLIC_OPS),
      token_env: 'FIXTURE_TOKEN',
    })
  );
} else {
  const response = await fetch(`${endpoint}/${op}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.ARCHON_FORGE_TOKEN ?? ''}` },
    body: readFileSync(0, 'utf8'),
  });
  process.stdout.write(await response.text());
  process.exitCode = response.ok ? 0 : 1;
}
