// An independently compilable protocol fixture. It imports no Archon code.
export {};
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
} else {
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
