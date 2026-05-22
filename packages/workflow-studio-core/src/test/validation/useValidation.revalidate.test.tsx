import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { useValidation } from '../../validation/useValidation';
import { ApiClientProvider } from '../../api/ApiClientProvider';
import type { WorkflowApiClient } from '../../api/WorkflowApiClient';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => cleanup());

const stubClient: WorkflowApiClient = {
  ping: async () => ({ ok: true }),
  listCodebases: async () => null,
  listWorkflows: async () => [],
  listCommands: async () => [],
  listProviders: async () => [],
  getWorkflow: async () => ({ name: '', description: '', nodes: [] }) as never,
  saveWorkflow: async (_n, _c, d) => d,
  deleteWorkflow: async () => undefined,
  validateWorkflow: async () => ({ valid: true }),
};

function Probe({ onState }: { onState: (s: ReturnType<typeof useValidation>) => void }): null {
  const state = useValidation();
  onState(state);
  return null;
}

describe('useValidation().revalidate', () => {
  it('is a stable function reference across re-renders', () => {
    const snapshots: Array<ReturnType<typeof useValidation>> = [];
    const { rerender } = render(
      <ApiClientProvider client={stubClient}>
        <Probe onState={s => snapshots.push(s)} />
      </ApiClientProvider>
    );
    rerender(
      <ApiClientProvider client={stubClient}>
        <Probe onState={s => snapshots.push(s)} />
      </ApiClientProvider>
    );

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const first = snapshots[0]!;
    const second = snapshots[snapshots.length - 1]!;
    expect(typeof first.revalidate).toBe('function');
    expect(first.revalidate).toBe(second.revalidate);
  });
});
