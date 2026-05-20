/**
 * Tests for WebWorkflowApiClient.
 *
 * Pattern: `spyOn(api, '<fn>')` against the imported `@/lib/api` namespace.
 * Per CLAUDE.md mock isolation rules, we do NOT use `mock.module()` — it is
 * process-global and irreversible. `spyOn` returns a spy that we restore inside
 * each test's `finally` block, so other tests in the `src/lib/` batch are unaffected.
 *
 * The single `as unknown as <ArchonType>` cast per fixture is the documented
 * exception (CLAUDE.md ESLint guidelines): the input shape is an external Archon
 * response type with ~10 fields we don't care about for this adapter test, and the
 * assertion is on the adapter's *output*, not the fixture's completeness.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import * as api from '@/lib/api';
import { WebWorkflowApiClient, createWebWorkflowApiClient } from './web-workflow-api-client';
import type { WorkflowDefinition } from '@archon/workflow-studio-core';

const minimalWorkflow = {
  name: 'demo',
  version: 1,
  nodes: [],
} as unknown as WorkflowDefinition;

describe('WebWorkflowApiClient', () => {
  // ---------- Task 4: happy-path coverage (one test per interface method) ----------

  test('listCodebases maps CodebaseResponse to CodebaseInfo and drops extra fields', async () => {
    const spy = spyOn(api, 'listCodebases').mockResolvedValue([
      {
        id: 'c1',
        name: 'demo',
        repository_url: 'https://example.com/repo.git',
        default_cwd: '/repo',
        ai_assistant_type: 'claude',
        commands: {},
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.listCodebases();
      expect(out).toEqual([{ id: 'c1', name: 'demo', default_cwd: '/repo' }]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('listWorkflows forwards cwd and returns WorkflowListItem[]', async () => {
    const spy = spyOn(api, 'listWorkflows').mockResolvedValue([
      { workflow: minimalWorkflow as api.WorkflowDefinition, source: 'project' },
      { workflow: minimalWorkflow as api.WorkflowDefinition, source: 'bundled' },
    ]);
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.listWorkflows('/repo');
      expect(spy).toHaveBeenCalledWith('/repo');
      expect(out).toHaveLength(2);
      expect(out[0]?.source).toBe('project');
      expect(out[1]?.source).toBe('bundled');
    } finally {
      spy.mockRestore();
    }
  });

  test('listCommands forwards cwd and returns { name, source }[]', async () => {
    const spy = spyOn(api, 'listCommands').mockResolvedValue([
      { name: 'help', source: 'bundled' },
      { name: 'mycmd', source: 'project' },
    ]);
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.listCommands('/repo');
      expect(spy).toHaveBeenCalledWith('/repo');
      expect(out).toEqual([
        { name: 'help', source: 'bundled' },
        { name: 'mycmd', source: 'project' },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('listProviders maps to { id, capabilities } and drops displayName/builtIn', async () => {
    const spy = spyOn(api, 'listProviders').mockResolvedValue([
      {
        id: 'claude',
        displayName: 'Claude',
        capabilities: { streaming: true, tools: true },
        builtIn: true,
      },
      {
        id: 'codex',
        displayName: 'Codex',
        capabilities: { streaming: true, tools: false },
        builtIn: true,
      },
    ]);
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.listProviders();
      expect(out).toEqual([
        { id: 'claude', capabilities: { streaming: true, tools: true } },
        { id: 'codex', capabilities: { streaming: true, tools: false } },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('getWorkflow unwraps .workflow from GetWorkflowResponse', async () => {
    const spy = spyOn(api, 'getWorkflow').mockResolvedValue({
      workflow: minimalWorkflow as api.WorkflowDefinition,
      filename: 'demo.yaml',
      source: 'project',
    });
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.getWorkflow('demo', '/repo');
      expect(spy).toHaveBeenCalledWith('demo', '/repo');
      expect(out).toBe(minimalWorkflow as unknown as WorkflowDefinition);
    } finally {
      spy.mockRestore();
    }
  });

  test('saveWorkflow reorders args to api.saveWorkflow(name, definition, cwd) and returns .workflow', async () => {
    const spy = spyOn(api, 'saveWorkflow').mockResolvedValue({
      workflow: minimalWorkflow as api.WorkflowDefinition,
      filename: 'demo.yaml',
      source: 'project',
    });
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.saveWorkflow('demo', '/repo', minimalWorkflow);
      // Critical: positional reorder. Studio passes (name, cwd, definition);
      // Archon's api.saveWorkflow expects (name, definition, cwd).
      expect(spy).toHaveBeenCalledWith('demo', minimalWorkflow, '/repo');
      expect(out).toBe(minimalWorkflow as unknown as WorkflowDefinition);
    } finally {
      spy.mockRestore();
    }
  });

  test('deleteWorkflow calls api.deleteWorkflow(name, cwd) and returns undefined', async () => {
    const spy = spyOn(api, 'deleteWorkflow').mockResolvedValue({ deleted: true, name: 'demo' });
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.deleteWorkflow('demo', '/repo');
      expect(spy).toHaveBeenCalledWith('demo', '/repo');
      expect(out).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test('validateWorkflow forwards definition and returns { valid, errors? }', async () => {
    const spy = spyOn(api, 'validateWorkflow').mockResolvedValue({
      valid: false,
      errors: ['nodes[0]: missing id'],
    });
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.validateWorkflow(minimalWorkflow);
      expect(spy).toHaveBeenCalledWith(minimalWorkflow);
      expect(out).toEqual({ valid: false, errors: ['nodes[0]: missing id'] });
    } finally {
      spy.mockRestore();
    }
  });

  test('ping maps HealthResponse.version to serverVersion', async () => {
    const spy = spyOn(api, 'getHealth').mockResolvedValue({
      status: 'ok',
      adapter: 'web',
      concurrency: { active: 0, queuedTotal: 0, maxConcurrent: 4 },
      runningWorkflows: 0,
      version: '0.3.12',
      is_docker: false,
    });
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.ping();
      expect(out).toEqual({ ok: true, serverVersion: '0.3.12' });
    } finally {
      spy.mockRestore();
    }
  });

  // ---------- Task 5: error and edge cases ----------

  test('listCodebases returns null when api.listCodebases rejects with { status: 404 }', async () => {
    const err = new Error('API error 404 (/api/codebases): not found') as Error & {
      status: number;
    };
    err.status = 404;
    const spy = spyOn(api, 'listCodebases').mockRejectedValue(err);
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.listCodebases();
      expect(out).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('listCodebases rethrows non-404 errors verbatim (error identity preserved)', async () => {
    const err = new Error('API error 500 (/api/codebases): boom') as Error & { status: number };
    err.status = 500;
    const spy = spyOn(api, 'listCodebases').mockRejectedValue(err);
    try {
      const client = new WebWorkflowApiClient();
      let caught: unknown;
      try {
        await client.listCodebases();
      } catch (e) {
        caught = e;
      }
      // Assert the exact error instance flows through, not just a message match.
      expect(caught).toBe(err);
    } finally {
      spy.mockRestore();
    }
  });

  test('assertWorkflowSource throws when server returns a source outside the union (via listWorkflows)', async () => {
    const spy = spyOn(api, 'listWorkflows').mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { workflow: minimalWorkflow as api.WorkflowDefinition, source: 'malformed' as any },
    ]);
    try {
      const client = new WebWorkflowApiClient();
      await expect(client.listWorkflows('/repo')).rejects.toThrow(
        /unexpected workflow source 'malformed'/
      );
    } finally {
      spy.mockRestore();
    }
  });

  test('ping resolves with serverVersion: undefined when HealthResponse.version is absent', async () => {
    const spy = spyOn(api, 'getHealth').mockResolvedValue({
      status: 'ok',
      adapter: 'web',
      concurrency: { active: 0, queuedTotal: 0, maxConcurrent: 4 },
      runningWorkflows: 0,
      // version omitted
      is_docker: false,
    });
    try {
      const client = new WebWorkflowApiClient();
      const out = await client.ping();
      expect(out).toEqual({ ok: true, serverVersion: undefined });
    } finally {
      spy.mockRestore();
    }
  });

  test('constructor injection: { apiNamespace } redirects calls to the supplied stub', async () => {
    let called = false;
    const stub: Partial<typeof api> = {
      getHealth: async () => {
        called = true;
        return {
          status: 'ok',
          adapter: 'stub',
          concurrency: { active: 0, queuedTotal: 0, maxConcurrent: 1 },
          runningWorkflows: 0,
          version: 'stub-1.0',
          is_docker: false,
        };
      },
    };
    const client = createWebWorkflowApiClient({ apiNamespace: stub as typeof api });
    const out = await client.ping();
    expect(called).toBe(true);
    expect(out).toEqual({ ok: true, serverVersion: 'stub-1.0' });
  });
});
