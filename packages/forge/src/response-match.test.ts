import { createHash } from 'node:crypto';
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

test('an applied review answers the request only when it echoes its commit, key and comments in order', () => {
  const ref = { repo: { host: 'forge.example', path: 'team/repo' }, number: 7 };
  const request = {
    operationId: 'review',
    op: 'pr.review.submit' as const,
    ref,
    commit: 'commit-a',
    key: 'run-1',
    summary: 'Two findings.',
    comments: [
      { path: 'a.ts', line: 3, body: 'one' },
      { path: 'b.ts', line: 9, body: 'two' },
    ],
  };
  const placed = [
    { path: 'a.ts', line: 3, placed: 'inline' as const },
    { path: 'b.ts', line: 9, placed: 'summary' as const },
  ];
  const answer = (overrides: { commit?: string; comments?: typeof placed } = {}) =>
    matchesForgeOperationResponse(
      request,
      {
        operationId: 'review',
        ok: true,
        result: {
          op: 'pr.review.submit',
          value: {
            target: ref,
            outcome: 'applied',
            changed: true,
            review: {
              ref,
              id: '100',
              url: 'https://forge.example/team/repo/pull/7#review-100',
              commit: overrides.commit ?? 'commit-a',
              key: 'run-1',
              bodyDigest: 'digest',
            },
            comments: overrides.comments ?? placed,
          },
        },
      },
      metadata,
      'forge.example'
    );
  expect(answer()).toBe(true);
  expect(answer({ commit: 'commit-b' })).toBe(false);
  expect(answer({ comments: [...placed].reverse() })).toBe(false);
  expect(answer({ comments: placed.slice(0, 1) })).toBe(false);
});

test('a stored attachment answers the request only when its digest, size and type are those of the bytes sent', () => {
  const repo = { host: 'forge.example', path: 'team/repo' };
  const bytes = Buffer.from('image bytes');
  const request = {
    operationId: 'attach',
    op: 'attachment.put' as const,
    repo,
    contentType: 'image/png' as const,
    content: bytes.toString('base64'),
  };
  const digest = createHash('sha256').update(bytes).digest('hex');
  const answer = (
    overrides: { digest?: string; bytes?: number; contentType?: 'image/png' | 'image/gif' } = {}
  ) =>
    matchesForgeOperationResponse(
      request,
      {
        operationId: 'attach',
        ok: true,
        result: {
          op: 'attachment.put',
          value: {
            target: repo,
            outcome: 'applied',
            changed: true,
            attachment: {
              url: `https://forge.example/team/repo/blob/c1/${digest}.png?raw=true`,
              digest: overrides.digest ?? digest,
              bytes: overrides.bytes ?? bytes.byteLength,
              contentType: overrides.contentType ?? 'image/png',
            },
          },
        },
      },
      metadata,
      'forge.example'
    );
  expect(answer()).toBe(true);
  expect(answer({ digest: 'f'.repeat(64) })).toBe(false);
  expect(answer({ bytes: bytes.byteLength + 1 })).toBe(false);
  expect(answer({ contentType: 'image/gif' })).toBe(false);
});

test('a merge refusal that observed another pull request merged does not answer the request', () => {
  const repo = { host: 'forge.example', path: 'team/repo' };
  const request = {
    operationId: 'merge',
    op: 'pr.merge' as const,
    ref: { repo, number: 51 },
    method: 'squash' as const,
    conditions: { head: 'head' },
  };
  const refusal = (number: number) => ({
    operationId: 'merge',
    ok: false as const,
    error: { kind: 'conflict' as const, message: 'already merged' },
    mutation: {
      op: 'pr.merge' as const,
      target: request.ref,
      outcome: 'refused' as const,
      merge: { method: 'squash' as const, conditions: request.conditions },
      observed: {
        repo,
        number,
        schemaVersion: 1 as const,
        url: `https://forge.example/team/repo/pull/${String(number)}`,
        head: 'feat',
        base: 'dev',
        is_draft: false,
        state: 'merged' as const,
        head_repo: repo,
        head_revision: 'head',
        base_revision: 'base',
        maintainer_can_modify: null,
      },
    },
  });
  expect(matchesForgeOperationResponse(request, refusal(51), metadata, 'forge.example')).toBe(true);
  expect(matchesForgeOperationResponse(request, refusal(52), metadata, 'forge.example')).toBe(
    false
  );
});
