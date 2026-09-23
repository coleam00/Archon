import { basename } from 'node:path';
const name = basename(process.execPath)
  .replace(/^archon-forge-/, '')
  .replace(/\.exe$/, '');
if (process.argv.at(-1) === 'metadata') {
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
