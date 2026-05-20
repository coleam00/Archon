import { describe, it, expect, afterEach } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { SmartGuidesLayer } from '../../components/SmartGuidesLayer';
import type { Guide } from '../../smart-guides';

afterEach(() => cleanup());

describe('<SmartGuidesLayer>', () => {
  it('renders nothing when guides array is empty', () => {
    const { container } = render(<SmartGuidesLayer guides={[]} width={800} height={600} />);
    const lines = container.querySelectorAll('line');
    expect(lines).toHaveLength(0);
  });

  it('renders one line per guide', () => {
    const guides: Guide[] = [
      { type: 'vertical', position: 100 },
      { type: 'horizontal', position: 200 },
    ];
    const { container } = render(<SmartGuidesLayer guides={guides} width={800} height={600} />);
    const lines = container.querySelectorAll('line');
    expect(lines).toHaveLength(2);
  });

  it('vertical guide renders full-height vertical line', () => {
    const guides: Guide[] = [{ type: 'vertical', position: 150 }];
    const { container } = render(<SmartGuidesLayer guides={guides} width={800} height={600} />);
    const line = container.querySelector('line')!;
    expect(line.getAttribute('x1')).toBe('150');
    expect(line.getAttribute('x2')).toBe('150');
    expect(line.getAttribute('y1')).toBe('0');
    expect(line.getAttribute('y2')).toBe('600');
  });

  it('horizontal guide renders full-width horizontal line', () => {
    const guides: Guide[] = [{ type: 'horizontal', position: 250 }];
    const { container } = render(<SmartGuidesLayer guides={guides} width={800} height={600} />);
    const line = container.querySelector('line')!;
    expect(line.getAttribute('y1')).toBe('250');
    expect(line.getAttribute('y2')).toBe('250');
    expect(line.getAttribute('x1')).toBe('0');
    expect(line.getAttribute('x2')).toBe('800');
  });
});
