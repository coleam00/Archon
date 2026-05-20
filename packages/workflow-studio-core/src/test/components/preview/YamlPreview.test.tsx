import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { YamlPreview } from '../../../components/preview/YamlPreview';

describe('YamlPreview', () => {
  it('renders the yaml text into the editor surface', () => {
    const yaml = 'name: hello\ndescription: d\nnodes: []\n';
    const { container } = render(
      <YamlPreview
        yaml={yaml}
        sourceMap={[]}
        selectedNodeId={null}
        hoveredNodeId={null}
        onLinePick={() => {}}
      />
    );
    expect(container.querySelector('.cm-editor')).toBeTruthy();
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('description');
  });

  it('does not allow editing (read-only)', () => {
    const { container } = render(
      <YamlPreview
        yaml="name: hello\n"
        sourceMap={[]}
        selectedNodeId={null}
        hoveredNodeId={null}
        onLinePick={() => {}}
      />
    );
    const content = container.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('false');
  });
});
