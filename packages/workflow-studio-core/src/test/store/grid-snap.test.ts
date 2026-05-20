import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';

describe('gridSnap slice', () => {
  beforeEach(() => useBuilderStore.setState({ gridSnap: false }));
  afterEach(() => useBuilderStore.setState({ gridSnap: false }));

  it('defaults to false', () => {
    expect(useBuilderStore.getState().gridSnap).toBe(false);
  });

  it('toggleGridSnap flips the value', () => {
    useBuilderStore.getState().toggleGridSnap();
    expect(useBuilderStore.getState().gridSnap).toBe(true);
    useBuilderStore.getState().toggleGridSnap();
    expect(useBuilderStore.getState().gridSnap).toBe(false);
  });
});
