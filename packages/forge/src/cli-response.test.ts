import { expect, test } from 'bun:test';
import { cliForgeResponseSchema, type CliForgeResponse } from './cli-response';

test.each([true, false])('host envelope retains credential source (ok: %s)', ok => {
  const response = cliForgeResponseSchema.parse({
    operationId: 'fixture',
    ok,
    credentialSource: 'GH_TOKEN',
    ...(ok
      ? { result: { op: 'pr.view', value: null } }
      : { error: { kind: 'authorization', message: 'Rejected' } }),
  });
  expect(response).toHaveProperty('credentialSource', 'GH_TOKEN');
});

test('host envelope validates discovery metadata', () => {
  const response = {
    operationId: 'fixture',
    ok: true,
    result: {
      op: 'metadata',
      value: {
        protocol: 1,
        name: 'github',
        version: 'test',
        forge: 'github',
        hosts: ['github.com'],
        capabilities: ['pr.view'],
        token_env: ['GH_TOKEN'],
      },
    },
  } satisfies CliForgeResponse;
  expect(cliForgeResponseSchema.parse(response)).toEqual(response);
  expect(
    cliForgeResponseSchema.safeParse({ ...response, result: { op: 'metadata', value: {} } }).success
  ).toBe(false);
});
