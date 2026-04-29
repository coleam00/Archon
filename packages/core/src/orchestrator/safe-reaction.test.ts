import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { IPlatformAdapter } from '../types';
import { safeAddReaction, safeRemoveReaction } from './orchestrator-agent';

// Minimal mock of IPlatformAdapter for reaction testing
const createMockPlatform = (): IPlatformAdapter => {
  const platform: IPlatformAdapter = {
    getPlatformType: mock(() => 'slack'),
    sendMessage: mock(() => Promise.resolve()),
  };
  return platform;
};

describe('Reaction Helpers', () => {
  let mockPlatform: IPlatformAdapter;

  beforeEach(() => {
    mockPlatform = createMockPlatform();
  });

  describe('safeAddReaction', () => {
    it('calls platform.addReaction when it exists', async () => {
      const addReactionSpy = mock(() => Promise.resolve());
      mockPlatform.addReaction = addReactionSpy;

      await safeAddReaction(mockPlatform, 'channel:123', 'eyes');

      expect(addReactionSpy).toHaveBeenCalledWith('channel:123', 'eyes');
    });

    it('gracefully returns when platform.addReaction is undefined', async () => {
      mockPlatform.addReaction = undefined;

      await expect(safeAddReaction(mockPlatform, 'channel:123', 'eyes')).resolves.toBeUndefined();
    });

    it('catches and logs errors without throwing', async () => {
      const error = new Error('API error');
      mockPlatform.addReaction = mock(() => Promise.reject(error));

      await expect(safeAddReaction(mockPlatform, 'channel:123', 'eyes')).resolves.toBeUndefined();
    });
  });

  describe('safeRemoveReaction', () => {
    it('calls platform.removeReaction when it exists', async () => {
      const removeReactionSpy = mock(() => Promise.resolve());
      mockPlatform.removeReaction = removeReactionSpy;

      await safeRemoveReaction(mockPlatform, 'channel:123', 'eyes');

      expect(removeReactionSpy).toHaveBeenCalledWith('channel:123', 'eyes');
    });

    it('gracefully returns when platform.removeReaction is undefined', async () => {
      mockPlatform.removeReaction = undefined;

      await expect(
        safeRemoveReaction(mockPlatform, 'channel:123', 'eyes')
      ).resolves.toBeUndefined();
    });

    it('catches and logs errors without throwing', async () => {
      const error = new Error('API error');
      mockPlatform.removeReaction = mock(() => Promise.reject(error));

      await expect(
        safeRemoveReaction(mockPlatform, 'channel:123', 'eyes')
      ).resolves.toBeUndefined();
    });
  });
});
