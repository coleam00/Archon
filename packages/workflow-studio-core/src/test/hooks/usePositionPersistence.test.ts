import { describe, it, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  loadPersistedPositions,
  persistPositions,
  positionStorageKey,
} from '../../hooks/usePositionPersistence';

beforeEach(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  globalThis.localStorage.clear();
});

describe('positionStorageKey', () => {
  it('joins archonUrl :: cwd :: workflowName', () => {
    expect(positionStorageKey('http://localhost:3737', '/repos/foo', 'wf-1')).toBe(
      'studio:positions:http://localhost:3737::/repos/foo::wf-1'
    );
  });
});

describe('loadPersistedPositions', () => {
  it('returns empty map when nothing stored', () => {
    expect(loadPersistedPositions('a', 'b', 'c').size).toBe(0);
  });

  it('round-trips a positions map', () => {
    persistPositions(
      'a',
      'b',
      'c',
      new Map([
        ['n1', { x: 100, y: 200 }],
        ['n2', { x: 300, y: 400 }],
      ])
    );
    const got = loadPersistedPositions('a', 'b', 'c');
    expect(got.get('n1')).toEqual({ x: 100, y: 200 });
    expect(got.get('n2')).toEqual({ x: 300, y: 400 });
  });

  it('returns empty map when stored payload is corrupt JSON', () => {
    globalThis.localStorage.setItem(positionStorageKey('a', 'b', 'c'), 'NOT_JSON');
    expect(loadPersistedPositions('a', 'b', 'c').size).toBe(0);
  });
});

describe('usePositionPersistence (hook)', () => {
  it('does not persist synchronously when setPosition is called', async () => {
    const { usePositionPersistence } = await import('../../hooks/usePositionPersistence');
    const { result, unmount } = renderHook(() => usePositionPersistence('u', 'c', 'wf'));
    act(() => {
      result.current.setPosition('n1', { x: 50, y: 60 });
    });
    // setPosition updates in-memory state immediately…
    expect(result.current.positions.get('n1')).toEqual({ x: 50, y: 60 });
    // …but localStorage is still empty (debounced).
    expect(globalThis.localStorage.getItem(positionStorageKey('u', 'c', 'wf'))).toBeNull();
    unmount();
  });

  it('persists after the debounce window elapses', async () => {
    const { usePositionPersistence } = await import('../../hooks/usePositionPersistence');
    const { result, unmount } = renderHook(() => usePositionPersistence('u', 'c', 'wf'));
    act(() => {
      result.current.setPosition('n1', { x: 50, y: 60 });
    });
    await new Promise(resolve => setTimeout(resolve, 250)); // > 200ms debounce
    const raw = globalThis.localStorage.getItem(positionStorageKey('u', 'c', 'wf'));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ n1: { x: 50, y: 60 } });
    unmount();
  });

  it('flushes pending writes on unmount before the debounce expires', async () => {
    const { usePositionPersistence } = await import('../../hooks/usePositionPersistence');
    const { result, unmount } = renderHook(() => usePositionPersistence('u', 'c', 'wf'));
    act(() => {
      result.current.setPosition('n1', { x: 11, y: 22 });
    });
    expect(globalThis.localStorage.getItem(positionStorageKey('u', 'c', 'wf'))).toBeNull();
    unmount();
    // Unmount cleanup synchronously calls flush().
    const raw = globalThis.localStorage.getItem(positionStorageKey('u', 'c', 'wf'));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ n1: { x: 11, y: 22 } });
  });

  it('reset() clears state and removes the localStorage entry', async () => {
    const { usePositionPersistence } = await import('../../hooks/usePositionPersistence');
    persistPositions('u', 'c', 'wf', new Map([['x', { x: 1, y: 2 }]]));
    const { result, unmount } = renderHook(() => usePositionPersistence('u', 'c', 'wf'));
    expect(result.current.positions.get('x')).toEqual({ x: 1, y: 2 });
    act(() => {
      result.current.reset();
    });
    expect(result.current.positions.size).toBe(0);
    expect(globalThis.localStorage.getItem(positionStorageKey('u', 'c', 'wf'))).toBeNull();
    unmount();
  });
});
