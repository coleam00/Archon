// An independently compilable protocol fixture. It imports no Archon code. One compiled
// binary serves every forge executable test: it behaves according to the name it is
// installed under (`archon-forge-<name>`), so a test hard-links it rather than compiling
// its own copy, which on windows-latest is an ~86 MB write costing seconds (#2924).
import { basename } from 'node:path';
const name = basename(process.execPath)
  .replace(/^archon-forge-/, '')
  .replace(/\.exe$/, '');
if (name === 'external-fixture') await externalFixture();
else if (process.argv.at(-1) === 'metadata') {
  if (name === 'invalid') console.log('{');
  else if (name === 'failed') process.exitCode = 7;
  else if (name === 'timeout') setInterval(Date.now, 1_000);
  else
    console.log(
      JSON.stringify({
        protocol: name === 'incompatible' ? 2 : 1,
        name: name === 'mismatch' ? 'other' : name,
        version: '1',
        forge: 'fixture',
        hosts: [`${name}.example`],
        capabilities: ['resolve'],
        token_env: [],
      })
    );
} else {
  const request = await Bun.stdin.json();
  console.log(
    JSON.stringify({
      operationId: request.operationId,
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    })
  );
}

/** A `checks.state` producer that maps its own token variable and inherits nothing else. */
async function externalFixture(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'metadata') {
    if (process.env.ARCHON_FORGE_TOKEN) process.exit(9);
    console.log(
      JSON.stringify({
        protocol: 1,
        name: 'external-fixture',
        version: '1',
        forge: 'fixture',
        hosts: ['fixture.invalid'],
        capabilities: ['checks.state'],
        token_env: ['EXTERNAL_FORGE_TOKEN'],
      })
    );
    return;
  }
  const request: unknown = await Bun.stdin.json();
  if (
    typeof request !== 'object' ||
    request === null ||
    !('operationId' in request) ||
    typeof request.operationId !== 'string' ||
    !('ref' in request) ||
    args[0] !== 'op' ||
    args[1] !== 'checks.state'
  )
    process.exit(7);
  if (
    process.env.UNRELATED_SECRET ||
    process.env.EXTERNAL_FORGE_TOKEN ||
    process.env.ARCHON_FORGE_TOKEN !== 'fixture-credential'
  )
    process.exit(8);
  console.log(
    JSON.stringify({
      operationId: request.operationId,
      ok: true,
      result: {
        op: 'checks.state',
        value: {
          ref: request.ref,
          revision: 'fixture-revision',
          units: [
            {
              unit: { kind: 'commit_status', id: 'external-1', name: 'external build' },
              nativeState: 'success',
              phase: 'completed',
              nativeResult: 'success',
              result: 'success',
              state: 'green',
            },
          ],
          summary: {
            state: 'green',
            counts: { total: 1, green: 1, red: 0, pending: 0, gated: 0, unknown: 0 },
          },
          required: null,
        },
      },
    })
  );
}
