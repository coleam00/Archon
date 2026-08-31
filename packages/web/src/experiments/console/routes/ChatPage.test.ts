import { describe, it, expect } from 'bun:test';
import { resolveNextActiveConversation } from './ChatPage';

describe('resolveNextActiveConversation', () => {
  it('should keep active conversation if deleted conversation is not active', () => {
    const convs = [{ id: 'conv-1' }, { id: 'conv-2' }, { id: 'conv-3' }];
    const result = resolveNextActiveConversation('conv-2', 'conv-1', convs);
    expect(result).toBe('conv-1');
  });

  it('should select next remaining conversation when active is deleted', () => {
    const convs = [{ id: 'conv-1' }, { id: 'conv-2' }, { id: 'conv-3' }];
    const result = resolveNextActiveConversation('conv-1', 'conv-1', convs);
    expect(result).toBe('conv-2');
  });

  it('should select remaining conversation when active is last in list', () => {
    const convs = [{ id: 'conv-1' }, { id: 'conv-2' }];
    const result = resolveNextActiveConversation('conv-2', 'conv-2', convs);
    expect(result).toBe('conv-1');
  });

  it('should return null when the sole remaining conversation is deleted', () => {
    const convs = [{ id: 'conv-1' }];
    const result = resolveNextActiveConversation('conv-1', 'conv-1', convs);
    expect(result).toBeNull();
  });

  it('should return null when conversation list is empty', () => {
    const result = resolveNextActiveConversation('conv-1', 'conv-1', []);
    expect(result).toBeNull();
  });

  it('should handle null activeId gracefully', () => {
    const convs = [{ id: 'conv-1' }, { id: 'conv-2' }];
    const result = resolveNextActiveConversation('conv-1', null, convs);
    expect(result).toBeNull();
  });
});
