import { describe, expect, it, spyOn } from 'bun:test';
import { workflowStoreDouble } from './test-utils';

describe('workflowStoreDouble', () => {
  it('calls the methods a test implements', async () => {
    const store = workflowStoreDouble({ getWorkflowRunStatus: async () => 'paused' });
    expect(await store.getWorkflowRunStatus('run-1')).toBe('paused');
  });

  it('fails a call to a method the test did not set up, naming it', () => {
    const store = workflowStoreDouble({});
    expect(() => store.getItem('item-1')).toThrow('Unexpected getItem');
  });

  it('treats a method set to undefined as not set up, however it is defined', () => {
    const hidden = Object.defineProperty({}, 'getItem', { value: undefined });
    for (const implemented of [{ getItem: undefined }, hidden]) {
      const store = workflowStoreDouble(implemented);
      expect(() => store.getItem('item-1')).toThrow('Unexpected getItem');
    }
  });

  it('can be awaited without reaching a fallback', async () => {
    const store = workflowStoreDouble({});
    expect(await Promise.resolve(store)).toBe(store);
  });

  it('makes each fallback once, so a mock fallback keeps its calls', () => {
    const store = workflowStoreDouble({}, method => () => method);
    expect(store.getItem).toBe(store.getItem);
    expect(store.getItem).not.toBe(store.getItemRuns);
  });

  it('lets a test spy on implemented and unset methods alike', async () => {
    const store = workflowStoreDouble({ getWorkflowRunStatus: async () => 'running' });
    spyOn(store, 'getWorkflowRunStatus').mockResolvedValue('paused');
    spyOn(store, 'getItem').mockResolvedValue(null);
    expect(await store.getWorkflowRunStatus('run-1')).toBe('paused');
    expect(await store.getItem('item-1')).toBeNull();
  });
});
