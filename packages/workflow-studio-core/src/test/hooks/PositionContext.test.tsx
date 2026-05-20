import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, renderHook, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { PositionProvider, usePositionContext } from '../../hooks/PositionContext';
import type { UsePositionPersistence } from '../../hooks/usePositionPersistence';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
afterEach(() => cleanup());

const stub: UsePositionPersistence = {
  positions: new Map(),
  setPosition: () => undefined,
  setMany: () => undefined,
  reset: () => undefined,
};

describe('PositionContext', () => {
  it('throws when read outside <PositionProvider>', () => {
    const Bad = () => {
      usePositionContext();
      return null;
    };
    expect(() => render(<Bad />)).toThrow(/PositionProvider/);
  });

  it('returns the provided handle inside <PositionProvider>', () => {
    const { result } = renderHook(() => usePositionContext(), {
      wrapper: ({ children }) => <PositionProvider value={stub}>{children}</PositionProvider>,
    });
    expect(result.current).toBe(stub);
  });
});
