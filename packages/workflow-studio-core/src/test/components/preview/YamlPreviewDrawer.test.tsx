import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { YamlPreviewDrawer } from '../../../components/preview/YamlPreviewDrawer';
import { useBuilderStore } from '../../../store/builder-store';

const initial = useBuilderStore.getState();
afterEach(() => {
  cleanup();
});
beforeEach(() => {
  useBuilderStore.setState(initial, true);
  useBuilderStore.getState().loadWorkflow({
    meta: { name: 'n', description: 'd', base: {}, unknown: {} },
    nodes: [{ id: 'a', variant: 'prompt', data: { prompt: 'x' }, base: {}, unknown: {} }],
  });
});

describe('YamlPreviewDrawer header', () => {
  it('renders the "may differ" note', () => {
    render(<YamlPreviewDrawer />);
    expect(screen.getByText(/may differ/i)).toBeTruthy();
  });

  it('copy button writes the yaml to navigator.clipboard', async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<YamlPreviewDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalled();
    expect(String(writeText.mock.calls[0]![0])).toContain('name: n');
  });

  it('download button creates a download blob with name <workflow>.yaml', () => {
    let downloadName: string | null = null;
    const origCreateObjectURL = URL.createObjectURL;
    const origCreate = document.createElement.bind(document);
    const click = mock(() => {});
    try {
      URL.createObjectURL = () => 'blob:fake';
      document.createElement = ((tag: string) => {
        const el = origCreate(tag);
        if (tag === 'a') {
          Object.defineProperty(el, 'click', { value: click, configurable: true });
          Object.defineProperty(el, 'download', {
            set(v: string) {
              downloadName = v;
            },
            configurable: true,
          });
        }
        return el;
      }) as typeof document.createElement;

      render(<YamlPreviewDrawer />);
      fireEvent.click(screen.getByRole('button', { name: /download/i }));
      expect(click).toHaveBeenCalled();
      expect(downloadName).toBe('n.yaml');
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      document.createElement = origCreate;
    }
  });

  it('Modified badge is hidden when current matches baseline', () => {
    render(<YamlPreviewDrawer />);
    expect(screen.queryByText(/modified/i)).toBeNull();
  });

  it('Modified badge appears when content has changed since load', () => {
    useBuilderStore.setState(s => ({
      nodes: s.nodes.map(n => (n.id === 'a' ? { ...n, data: { prompt: 'CHANGED' } } : n)),
    }));
    render(<YamlPreviewDrawer />);
    expect(screen.getByText(/modified/i)).toBeTruthy();
  });
});
