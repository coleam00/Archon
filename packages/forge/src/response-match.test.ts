import { expect, test } from 'bun:test';
import { matchesForgeOperationResponse } from './response-match';

const metadata = {
  protocol: 1 as const,
  name: 'test',
  version: '1.0.0',
  forge: 'test',
  hosts: ['forge.example'],
  capabilities: ['resolve' as const],
  token_env: [],
};

test.each([
  ['https://forge.example/team/repo', 'forge.example', true],
  ['https://forge.example:443/team/repo', 'forge.example', true],
  ['https://forge.example:443/team/repo', 'other.example', false],
  ['https://forge.example:8443/team/repo', 'forge.example', false],
  ['https://forge.example:8443/team/repo', 'forge.example:8443', true],
  ['http://forge.example:80/team/repo', 'forge.example', false],
  ['http://forge.example:443/team/repo', 'forge.example', false],
  ['ssh://git@forge.example:443/team/repo', 'forge.example', false],
  ['ssh://git@forge.example:443/team/repo', 'forge.example:443', true],
  ['ssh://git@forge.example:22/team/repo', 'forge.example:22', true],
  ['git@forge.example:team/repo.git', 'forge.example', true],
] as const)('validates normalized resolver identity for %s returning %s', (remote, host, valid) => {
  const requestedHost = remote.includes('://')
    ? remote.split('://')[1].split('/')[0].replace('git@', '')
    : 'forge.example';
  expect(
    matchesForgeOperationResponse(
      { operationId: 'identity', op: 'resolve', remote },
      {
        operationId: 'identity',
        ok: true,
        result: {
          op: 'resolve',
          value: {
            kind: 'resolved',
            forge: 'test',
            repo: { host, path: 'team/repo' },
            plugin: { name: 'test', version: '1.0.0' },
          },
        },
      },
      metadata,
      requestedHost
    )
  ).toBe(valid);
});

test('a resolved answer to an issue or pull request URL must name its subject', () => {
  const resolved = (subject?: { kind: 'pr'; number: number }) => ({
    operationId: 'web',
    ok: true as const,
    result: {
      op: 'resolve' as const,
      value: {
        kind: 'resolved' as const,
        forge: 'test',
        repo: { host: 'forge.example', path: 'team/repo' },
        plugin: { name: 'test', version: '1.0.0' },
        ...(subject ? { subject } : {}),
      },
    },
  });
  const request = {
    operationId: 'web',
    op: 'resolve' as const,
    remote: 'https://forge.example/team/repo/pull/1',
    web: true as const,
  };
  const matches = (response: ReturnType<typeof resolved>) =>
    matchesForgeOperationResponse(request, response, metadata, 'forge.example');
  expect(matches(resolved({ kind: 'pr', number: 1 }))).toBe(true);
  expect(matches(resolved())).toBe(false);
});
