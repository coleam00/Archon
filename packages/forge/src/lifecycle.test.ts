import { expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { dispatchForge } from './dispatch';
import type { PluginDiscovery } from './discovery';
import {
  forgeRequestSchema,
  forgeAuditResponse,
  forgeOperationAuditSchema,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
} from './operations';

const ref = { repo: { host: 'forge.example', path: 'owner/repo' }, number: 1 };
const pr = {
  ...ref,
  schemaVersion: 1 as const,
  url: 'https://forge.example/owner/repo/pull/1',
  head: 'feature',
  base: 'main',
  is_draft: false,
  state: 'open' as const,
  head_repo: ref.repo,
  head_revision: 'opaque-head',
  base_revision: 'opaque-base',
  maintainer_can_modify: true,
};
const metadata: PluginMetadata = {
  protocol: 1,
  name: 'fixture',
  version: '1',
  forge: 'fixture',
  hosts: [ref.repo.host],
  capabilities: ['pr.merge', 'pr.ready', 'pr.view'],
  token_env: [],
  operations: {
    'pr.merge': { methods: ['merge'], atomicConditions: ['head'], readback: ['commit'] },
  },
};
function discovery(
  marker: string,
  mode: string,
  response?: ForgeResponse,
  command = process.execPath
): PluginDiscovery {
  const plugin = {
    command,
    args: [
      join(import.meta.dir, 'fixtures/mutation-plugin.ts'),
      mode,
      marker,
      JSON.stringify(response),
    ],
    source: 'test',
    configured: true,
    metadata,
  };
  return {
    plugins: [plugin],
    unavailable: [],
    byHost: new Map([[ref.repo.host, plugin]]),
    hostConfig: new Map(),
    pluginTokenEnv: new Map(),
  };
}

test('unsupported guarantees and methods refuse before launching a mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-conditions-'));
  try {
    const marker = join(root, 'written');
    for (const request of [
      {
        operationId: 'base',
        op: 'pr.merge',
        ref,
        method: 'merge',
        required: { base: 'opaque-base' },
      },
      {
        operationId: 'tree',
        op: 'pr.merge',
        ref,
        method: 'merge',
        required: { head: 'opaque-head', resultTree: 'opaque-tree' },
      },
      { operationId: 'method', op: 'pr.merge', ref, method: 'squash', required: {} },
    ] satisfies ForgeRequest[]) {
      const result = await dispatchForge(request, { discovery: discovery(marker, 'malformed') });
      expect(result.response).toMatchObject({
        ok: false,
        mutation: { outcome: 'refused', requested: request.required, enforced: {} },
      });
    }
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(
      forgeRequestSchema.safeParse({
        operationId: 'unknown',
        op: 'pr.merge',
        ref,
        method: 'merge',
        required: { checkSnapshot: 'unsupported' },
      }).success
    ).toBe(false);
  } finally {
    await removeTempTree(root);
  }
});

test('launched write with lost protocol or timeout remains unknown; never-launched command is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-uncertainty-'));
  try {
    const request: ForgeRequest = { operationId: 'write', op: 'pr.ready', ref };
    for (const mode of ['malformed', 'timeout']) {
      const marker = join(root, mode);
      const result = await dispatchForge(request, {
        discovery: discovery(marker, mode),
        timeoutMs: 1500,
      });
      expect(await readFile(marker, 'utf8')).toBe('write happened');
      if (mode === 'timeout')
        expect(result.response).toMatchObject({ ok: false, error: { kind: 'timeout' } });
      expect(result.response).toMatchObject({
        ok: false,
        mutation: { outcome: 'outcome_unknown', op: 'pr.ready', target: ref },
      });
      expect(result.audit.result).toMatchObject({
        ok: false,
        mutation: { outcome: 'outcome_unknown' },
      });
    }
    const result = await dispatchForge(request, {
      discovery: discovery(
        join(root, 'missing'),
        'malformed',
        undefined,
        join(root, 'missing.exe')
      ),
    });
    expect(result.response).toMatchObject({
      ok: false,
      mutation: { outcome: 'refused' },
      error: { kind: 'process_failed' },
    });
  } finally {
    await removeTempTree(root);
  }
});

test('dispatch preserves verification failure and refuses contradictory applied evidence as unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-evidence-'));
  try {
    const request: ForgeRequest = {
      operationId: 'write',
      op: 'pr.merge',
      ref,
      method: 'merge',
      required: { head: 'opaque-head' },
    };
    const failure: ForgeResponse = {
      operationId: 'write',
      ok: false,
      error: { kind: 'forge_error', message: 'readback failed' },
      mutation: {
        op: 'pr.merge',
        outcome: 'verification_failed',
        target: ref,
        requested: request.required,
        enforced: request.required,
        leaveBehind: 'merge accepted; PR readback failed',
      },
    };
    const observed = await dispatchForge(request, {
      discovery: discovery(join(root, 'known'), 'failure', failure),
    });
    expect(observed.response).toEqual(failure);
    const contradiction: ForgeResponse = {
      operationId: 'write',
      ok: true,
      result: {
        op: 'pr.merge',
        value: {
          outcome: 'applied',
          target: ref,
          requested: request.required,
          enforced: {},
          changed: true,
          pr: { ...pr, state: 'merged' },
          method: 'merge',
          landed: {
            commit: { available: false, reason: 'unavailable' },
            tree: { available: false, reason: 'unavailable' },
            parents: { available: false, reason: 'unavailable' },
          },
        },
      },
    };
    const result = await dispatchForge(request, {
      discovery: discovery(join(root, 'contradiction'), 'success', contradiction),
    });
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
      mutation: { outcome: 'outcome_unknown' },
    });
  } finally {
    await removeTempTree(root);
  }
});

test('read-content audit retains identity and digest without storing authored content', () => {
  const response: ForgeResponse = {
    operationId: 'read',
    ok: true,
    result: { op: 'pr.view', value: { pr, title: 'private title', body: 'private message' } },
  };
  const audit = forgeOperationAuditSchema.parse({
    operationId: 'read',
    operation: 'pr.view',
    target: ref,
    plugin: { name: 'fixture', version: '1' },
    result: forgeAuditResponse(response),
    durationMs: 1,
  });
  expect(JSON.stringify(audit)).not.toContain('private');
  expect(audit.result).toMatchObject({ result: { value: { pr, content: { bytes: 50 } } } });
});
