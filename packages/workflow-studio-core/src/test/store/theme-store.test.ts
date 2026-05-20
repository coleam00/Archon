import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useThemeStore } from '../../store/theme-store';

describe('theme-store', () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({ preset: 'archon-dark' });
  });
  afterEach(() => {
    useThemeStore.setState({ preset: 'archon-dark' });
    localStorage.clear();
  });

  it('defaults to archon-dark when localStorage empty', () => {
    expect(useThemeStore.getState().preset).toBe('archon-dark');
  });

  it('setPreset writes to localStorage', () => {
    useThemeStore.getState().setPreset('light');
    expect(useThemeStore.getState().preset).toBe('light');
    expect(localStorage.getItem('archon-studio:theme')).toBe('light');
  });

  it('reads localStorage on hydrate()', () => {
    localStorage.setItem('archon-studio:theme', 'high-contrast');
    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().preset).toBe('high-contrast');
  });

  it('ignores invalid localStorage values', () => {
    localStorage.setItem('archon-studio:theme', 'midnight-purple');
    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().preset).toBe('archon-dark');
  });
});
