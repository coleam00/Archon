import { describe, it, expect } from 'bun:test';
import { SHORTCUTS } from '../shortcuts';

describe('SHORTCUTS', () => {
  it('exposes mod-based bindings (works as both Cmd and Ctrl)', () => {
    expect(SHORTCUTS.undo).toBe('mod+z');
    expect(SHORTCUTS.redo).toBe('mod+shift+z');
    expect(SHORTCUTS.copy).toBe('mod+c');
    expect(SHORTCUTS.paste).toBe('mod+v');
    expect(SHORTCUTS.cut).toBe('mod+x');
  });

  it('delete is an array of equivalent keys', () => {
    expect(SHORTCUTS.delete).toEqual(['delete', 'backspace']);
  });

  it('alignment shortcuts use mod+alt+arrow', () => {
    expect(SHORTCUTS.alignLeft).toBe('mod+alt+left');
    expect(SHORTCUTS.alignRight).toBe('mod+alt+right');
    expect(SHORTCUTS.alignTop).toBe('mod+alt+up');
    expect(SHORTCUTS.alignBottom).toBe('mod+alt+down');
  });
});
