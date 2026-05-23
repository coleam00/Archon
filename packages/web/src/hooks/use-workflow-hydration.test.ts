import { describe, test, expect, afterEach } from 'bun:test';
import { useBuilderStore } from '@archon/workflow-studio-core';
import type { WorkflowApiClient, WorkflowDefinition } from '@archon/workflow-studio-core';

import { hydrateWorkflowOnce } from './use-workflow-hydration';

/**
 * Hand-rolled stub satisfying just enough of `WorkflowApiClient` to drive
 * `hydrateWorkflowOnce`. The unrelated methods throw on call so any test
 * accidentally exercising them fails loudly rather than silently.
 */
function makeStubClient(getWorkflow: (name: string, cwd: string) => Promise<WorkflowDefinition>): {
  client: WorkflowApiClient;
  calls: { name: string; cwd: string }[];
} {
  const calls: { name: string; cwd: string }[] = [];
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
    getWorkflow: async (name, cwd): Promise<WorkflowDefinition> => {
      calls.push({ name, cwd });
      return getWorkflow(name, cwd);
    },
    saveWorkflow: fail('saveWorkflow'),
    deleteWorkflow: fail('deleteWorkflow'),
    validateWorkflow: fail('validateWorkflow'),
    ping: fail('ping'),
  };
  return { client, calls };
}

function makeErrorWithStatus(message: string, status: number): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('hydrateWorkflowOnce', () => {
  afterEach(() => {
    useBuilderStore.getState().clearWorkflow();
  });

  test('happy path: fetches, hydrates via loadWorkflow, returns loaded', async () => {
    const def = {
      name: 'demo',
      description: 'demo workflow',
      nodes: [{ id: 'step1', prompt: 'hello world' }],
    } as unknown as WorkflowDefinition;
    const { client, calls } = makeStubClient(async () => def);

    const captured: { name: string; nodeCount: number }[] = [];
    const loadWorkflow = (input: { meta: { name: string }; nodes: unknown[] }): void => {
      captured.push({ name: input.meta.name, nodeCount: input.nodes.length });
    };

    const outcome = await hydrateWorkflowOnce(client, 'demo', '/cwd', loadWorkflow);

    expect(outcome).toEqual({ status: 'loaded', error: null });
    expect(calls).toEqual([{ name: 'demo', cwd: '/cwd' }]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.name).toBe('demo');
    expect(captured[0]?.nodeCount).toBe(1);
  });

  test('404 path: seeds meta with requested name and placeholder description; returns not-found', async () => {
    const { client } = makeStubClient(async () => {
      throw makeErrorWithStatus('not found', 404);
    });

    type Seed = { meta: { name: string; description: string }; nodes: unknown[] };
    const captured: Seed[] = [];
    const loadWorkflow = (input: Seed): void => {
      captured.push(input);
    };

    const outcome = await hydrateWorkflowOnce(client, 'never-existed', '/cwd', loadWorkflow);

    expect(outcome).toEqual({ status: 'not-found', error: null });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.meta.name).toBe('never-existed');
    // Seeded with a placeholder (not empty) because the server's parseWorkflow
    // rejects empty descriptions, which would silently disable Save. See
    // use-workflow-hydration.ts and commit 8009fbb1 (unblock new-workflow save).
    expect(captured[0]?.meta.description).toBe('New workflow');
    expect(captured[0]?.nodes).toEqual([]);
  });

  test('non-404 error: loadWorkflow NOT called; returns error verbatim', async () => {
    const { client } = makeStubClient(async () => {
      throw makeErrorWithStatus('boom', 500);
    });

    let loadCalls = 0;
    const loadWorkflow = (): void => {
      loadCalls += 1;
    };

    const outcome = await hydrateWorkflowOnce(client, 'demo', '/cwd', loadWorkflow);

    expect(outcome?.status).toBe('error');
    expect(outcome?.error).toBeInstanceOf(Error);
    expect(outcome?.error?.message).toBe('boom');
    expect(loadCalls).toBe(0);
  });

  test('non-Error throw is wrapped in Error', async () => {
    const { client } = makeStubClient(() =>
      // Promise rejection lets us hit the catch block without ESLint flagging a literal throw.
      Promise.reject('string thrown')
    );
    const loadWorkflow = (): void => {};

    const outcome = await hydrateWorkflowOnce(client, 'demo', '/cwd', loadWorkflow);

    expect(outcome?.status).toBe('error');
    expect(outcome?.error).toBeInstanceOf(Error);
    expect(outcome?.error?.message).toBe('string thrown');
  });

  test('cancellation before GET resolves: returns null; loadWorkflow not called', async () => {
    const def = {
      name: 'demo',
      description: '',
      nodes: [],
    } as unknown as WorkflowDefinition;
    let resolveGet!: (v: WorkflowDefinition) => void;
    const { client } = makeStubClient(
      () =>
        new Promise<WorkflowDefinition>(resolve => {
          resolveGet = resolve;
        })
    );

    let cancelled = false;
    let loadCalls = 0;
    const loadWorkflow = (): void => {
      loadCalls += 1;
    };

    const pending = hydrateWorkflowOnce(client, 'demo', '/cwd', loadWorkflow, () => cancelled);
    cancelled = true;
    resolveGet(def);
    const outcome = await pending;

    expect(outcome).toBeNull();
    expect(loadCalls).toBe(0);
  });

  test('cancellation between GET rejection and 404 seed: returns null; no seed', async () => {
    let rejectGet!: (e: unknown) => void;
    const { client } = makeStubClient(
      () =>
        new Promise<WorkflowDefinition>((_resolve, reject) => {
          rejectGet = reject;
        })
    );

    let cancelled = false;
    let loadCalls = 0;
    const loadWorkflow = (): void => {
      loadCalls += 1;
    };

    const pending = hydrateWorkflowOnce(client, 'demo', '/cwd', loadWorkflow, () => cancelled);
    cancelled = true;
    rejectGet(makeErrorWithStatus('not found', 404));
    const outcome = await pending;

    expect(outcome).toBeNull();
    expect(loadCalls).toBe(0);
  });

  test('end-to-end against real builder store on happy path', async () => {
    const def = {
      name: 'store-int',
      description: 'integration',
      nodes: [{ id: 'a', prompt: 'hi' }],
    } as unknown as WorkflowDefinition;
    const { client } = makeStubClient(async () => def);

    const outcome = await hydrateWorkflowOnce(client, 'store-int', '/cwd', input =>
      useBuilderStore.getState().loadWorkflow(input)
    );

    expect(outcome).toEqual({ status: 'loaded', error: null });
    const state = useBuilderStore.getState();
    expect(state.workflow?.name).toBe('store-int');
    expect(state.workflow?.description).toBe('integration');
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]?.id).toBe('a');
  });
});
