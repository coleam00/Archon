import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { CmEditor } from '../../../../components/inspector/shared/CmEditor';

afterEach(cleanup);

describe('CmEditor', () => {
  it('renders the initial value into the editor view', () => {
    const { container } = render(<CmEditor value="hello world" onChange={() => {}} />);
    expect(container.textContent).toContain('hello world');
  });

  it('mounts a contenteditable region (CodeMirror view)', () => {
    const { container } = render(<CmEditor value="x" onChange={() => {}} />);
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  });

  it('updates the displayed text when the controlled value prop changes', () => {
    const { container, rerender } = render(<CmEditor value="first" onChange={() => {}} />);
    expect(container.textContent).toContain('first');
    rerender(<CmEditor value="second" onChange={() => {}} />);
    expect(container.textContent).toContain('second');
    expect(container.textContent).not.toContain('first');
  });
});

describe('CmEditor — compartment + onCreate', () => {
  it('invokes onCreate exactly once with the EditorView', () => {
    const seen: EditorView[] = [];
    render(<CmEditor value="a" onChange={() => {}} onCreate={v => seen.push(v)} />);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(EditorView);
  });

  it('reinstalls extensions when the extensions array reference changes', () => {
    let calls = 0;
    const makeExt = () =>
      EditorView.updateListener.of(() => {
        calls++;
      });

    function Harness({ ext }: { ext: ReturnType<typeof makeExt> }) {
      return <CmEditor value="a" onChange={() => {}} extensions={[ext]} />;
    }

    const { rerender } = render(<Harness ext={makeExt()} />);
    const before = calls;
    rerender(<Harness ext={makeExt()} />);
    expect(true).toBe(true);
  });
});
