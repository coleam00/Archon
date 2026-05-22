import { describe, it, expect, beforeAll, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { Toolbar } from '../../components/Toolbar';
import { PositionProvider } from '../../hooks/PositionContext';
import type { UsePositionPersistence } from '../../hooks/usePositionPersistence';
import type { ReactNode } from 'react';

const mockPositions: UsePositionPersistence = {
  positions: new Map(),
  setPosition: () => {},
  setMany: () => {},
  reset: () => {},
};

function WithPositions({ children }: { children: ReactNode }) {
  return <PositionProvider value={mockPositions}>{children}</PositionProvider>;
}

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => cleanup());

describe('Toolbar — Validate + Marketplace extras', () => {
  it('renders the Validate button and calls onValidate when clicked', () => {
    const onValidate = mock(() => {});
    render(
      <Toolbar
        workflowName="t"
        onResetLayout={() => {}}
        onValidate={onValidate}
        isValidating={false}
      />,
      { wrapper: WithPositions }
    );
    const btn = screen.getByRole('button', { name: /^validate$/i });
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    expect(onValidate).toHaveBeenCalledTimes(1);
  });

  it('shows loading state and disables the button when isValidating is true', () => {
    render(
      <Toolbar
        workflowName="t"
        onResetLayout={() => {}}
        onValidate={() => {}}
        isValidating={true}
      />,
      { wrapper: WithPositions }
    );
    const btn = screen.getByRole('button', { name: /validating/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.textContent).toContain('Validating');
  });

  it('renders a Marketplace anchor with correct href/target/rel when marketplaceUrl is set', () => {
    const url = 'https://example.test/CONTRIBUTING.md#m';
    render(<Toolbar workflowName="t" onResetLayout={() => {}} marketplaceUrl={url} />, {
      wrapper: WithPositions,
    });
    const anchor = screen.getByRole('link', { name: /share/i });
    expect(anchor.getAttribute('href')).toBe(url);
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders neither Validate nor Marketplace when props are omitted', () => {
    render(<Toolbar workflowName="t" onResetLayout={() => {}} />, { wrapper: WithPositions });
    expect(screen.queryByRole('button', { name: /validate/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /share/i })).toBeNull();
  });
});
