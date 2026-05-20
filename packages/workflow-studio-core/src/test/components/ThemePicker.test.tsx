import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ThemePicker } from '../../components/ThemePicker';
import { useThemeStore } from '../../store/theme-store';

describe('<ThemePicker>', () => {
  beforeEach(() => useThemeStore.setState({ preset: 'archon-dark' }));
  afterEach(() => {
    cleanup();
    useThemeStore.setState({ preset: 'archon-dark' });
  });

  it('renders three buttons; active one has aria-pressed=true', () => {
    const { getByLabelText } = render(<ThemePicker />);
    expect(getByLabelText('Theme: archon-dark').getAttribute('aria-pressed')).toBe('true');
    expect(getByLabelText('Theme: light').getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking a button updates the store', () => {
    const { getByLabelText } = render(<ThemePicker />);
    fireEvent.click(getByLabelText('Theme: light'));
    expect(useThemeStore.getState().preset).toBe('light');
  });
});
