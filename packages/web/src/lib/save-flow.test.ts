import { describe, test, expect } from 'bun:test';
import type {
  LoadWorkflowInput,
  WorkflowApiClient,
  WorkflowDefinition,
} from '@archon/workflow-studio-core';

import { runSaveFlow } from './save-flow';

interface StubCounters {
  validateCalls: { definition: WorkflowDefinition }[];
  saveCalls: { name: string; cwd: string; definition: WorkflowDefinition }[];
}

function makeStubClient(opts: {
  validate?: (definition: WorkflowDefinition) => Promise<{ valid: boolean; errors?: string[] }>;
  save?: (name: string, cwd: string, definition: WorkflowDefinition) => Promise<WorkflowDefinition>;
}): { client: WorkflowApiClient; counters: StubCounters } {
  const counters: StubCounters = { validateCalls: [], saveCalls: [] };
  const fail = (label: string): (() => never) => {
    return () => {
      throw new Error(`stub ${label} called unexpectedly`);
    };
  };
  const client: WorkflowApiClient = {
    listCodebases: fail('listCodebases'),
    listWorkflows: fail('listWorkflows'),
    listCommands: fail('listCommands'),
    listProviders: fail('listProviders'),
    getWorkflow: fail('getWorkflow'),
    deleteWorkflow: fail('deleteWorkflow'),
    ping: fail('ping'),
    validateWorkflow: async (definition): Promise<{ valid: boolean; errors?: string[] }> => {
      counters.validateCalls.push({ definition });
      return opts.validate ? opts.validate(definition) : { valid: true };
    },
    saveWorkflow: async (name, cwd, definition): Promise<WorkflowDefinition> => {
      counters.saveCalls.push({ name, cwd, definition });
      return opts.save ? opts.save(name, cwd, definition) : definition;
    },
  };
  return { client, counters };
}

/**
 * Minimal `LoadWorkflowInput` whose `toWorkflowDefinition` output satisfies
 * `workflowDefinitionSchema` (name+description non-empty, nodes empty).
 */
function makeValidSnapshot(name: string): LoadWorkflowInput {
  return {
    meta: { name, description: 'a workflow', base: {}, unknown: {} },
    nodes: [],
  };
}

describe('runSaveFlow', () => {
  test('empty name → invalid; client never called', async () => {
    const { client, counters } = makeStubClient({});
    const snapshot = makeValidSnapshot('   ');

    const result = await runSaveFlow(client, '/cwd', snapshot);

    expect(result).toEqual({ kind: 'invalid', errors: ['Workflow name is required'] });
    expect(counters.validateCalls).toHaveLength(0);
    expect(counters.saveCalls).toHaveLength(0);
  });

  test('happy path → validate+save called with (name, cwd, def); returns saved', async () => {
    const { client, counters } = makeStubClient({});
    const snapshot = makeValidSnapshot('  demo  ');

    const result = await runSaveFlow(client, '/repo', snapshot);

    expect(result).toEqual({ kind: 'saved', name: 'demo' });
    expect(counters.validateCalls).toHaveLength(1);
    expect(counters.saveCalls).toHaveLength(1);
    expect(counters.saveCalls[0]?.name).toBe('demo');
    expect(counters.saveCalls[0]?.cwd).toBe('/repo');
    expect(counters.saveCalls[0]?.definition).toBe(counters.validateCalls[0]?.definition);
  });

  test('server validation returns valid:false → invalid; save NOT called', async () => {
    const { client, counters } = makeStubClient({
      validate: async () => ({ valid: false, errors: ['bad node id', 'missing dep'] }),
    });
    const snapshot = makeValidSnapshot('demo');

    const result = await runSaveFlow(client, '/cwd', snapshot);

    expect(result).toEqual({ kind: 'invalid', errors: ['bad node id', 'missing dep'] });
    expect(counters.validateCalls).toHaveLength(1);
    expect(counters.saveCalls).toHaveLength(0);
  });

  test('server validation valid:false with no errors[] → fallback message', async () => {
    const { client } = makeStubClient({
      validate: async () => ({ valid: false }),
    });
    const result = await runSaveFlow(client, '/cwd', makeValidSnapshot('demo'));
    expect(result).toEqual({ kind: 'invalid', errors: ['Unknown validation error'] });
  });

  test('saveWorkflow throws → failed with the original error', async () => {
    const original = new Error('disk full');
    const { client } = makeStubClient({
      save: async () => {
        throw original;
      },
    });

    const result = await runSaveFlow(client, '/cwd', makeValidSnapshot('demo'));

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBe(original);
    }
  });

  test('validateWorkflow throws → failed with the original error', async () => {
    const original = new Error('network');
    const { client, counters } = makeStubClient({
      validate: async () => {
        throw original;
      },
    });

    const result = await runSaveFlow(client, '/cwd', makeValidSnapshot('demo'));

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBe(original);
    }
    expect(counters.saveCalls).toHaveLength(0);
  });

  test('non-Error throw → wrapped in Error', async () => {
    const { client } = makeStubClient({
      save: () => Promise.reject('weird string'),
    });

    const result = await runSaveFlow(client, '/cwd', makeValidSnapshot('demo'));

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('weird string');
    }
  });

  test('schema parse fails (empty description) → invalid; no network call', async () => {
    const { client, counters } = makeStubClient({});
    const snapshot: LoadWorkflowInput = {
      meta: { name: 'demo', description: '', base: {}, unknown: {} },
      nodes: [],
    };

    const result = await runSaveFlow(client, '/cwd', snapshot);

    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(counters.validateCalls).toHaveLength(0);
    expect(counters.saveCalls).toHaveLength(0);
  });
});
