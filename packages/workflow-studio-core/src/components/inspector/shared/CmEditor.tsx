import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { type CSSProperties, useEffect, useRef } from 'react';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Extra CodeMirror extensions. Re-applied via compartment when this array reference changes. */
  extensions?: Extension[];
  /** Called once with the EditorView right after mount. */
  onCreate?: (view: EditorView) => void;
  /** Visual minimum height in pixels. */
  minHeight?: number;
  /** Inline style overrides (parent-controlled width/font). */
  style?: CSSProperties;
  /** ARIA label for accessibility. */
  ariaLabel?: string;
}

/**
 * Thin wrapper over CodeMirror 6 that exposes a textarea-shaped contract
 * (value/onChange/extensions). Used wherever the inspector needs $-reference
 * autocomplete inside a body field. Atom-row value inputs intentionally use
 * native `<input>` instead — short literal values don't benefit from CM6.
 */
export function CmEditor({
  value,
  onChange,
  extensions = [],
  onCreate,
  minHeight = 80,
  style,
  ariaLabel,
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentRef = useRef<Compartment>(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;

  useEffect(() => {
    if (!hostRef.current) return;
    const compartment = compartmentRef.current;
    const startState = EditorState.create({
      doc: value,
      extensions: [
        keymap.of([...defaultKeymap, ...closeBracketsKeymap]),
        closeBrackets(),
        EditorView.lineWrapping,
        EditorView.updateListener.of(u => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        compartment.of(extensions),
      ],
    });
    const view = new EditorView({ state: startState, parent: hostRef.current });
    viewRef.current = view;
    onCreateRef.current?.(view);
    return (): void => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-once: extensions are managed via the compartment effect below.
  }, []);

  // Reconfigure compartment when the extensions reference changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: compartmentRef.current.reconfigure(extensions) });
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={hostRef}
      role="textbox"
      aria-label={ariaLabel}
      style={{
        minHeight,
        background: 'var(--studio-bg-elevated)',
        color: 'var(--studio-fg)',
        border: '1px solid var(--studio-border)',
        borderRadius: 'var(--radius-sm)',
        fontFamily: 'var(--studio-mono)',
        fontSize: 13,
        ...style,
      }}
    />
  );
}
