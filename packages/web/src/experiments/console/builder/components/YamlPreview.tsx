/**
 * Read-only, syntax-highlighted, searchable YAML preview pane — a port of the
 * standalone studio's CodeMirror preview. The string itself is produced by
 * the pure `serializeToYaml` (yaml/serialize.ts); CodeMirror only renders it.
 *
 * Theming maps CodeMirror's editor chrome and YAML highlight tags onto the
 * console's oklch tokens via `EditorView.theme` / `HighlightStyle` — no
 * default CodeMirror theme, no hard-coded hex.
 */
import { useMemo, useState, type ReactElement } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';

interface YamlPreviewProps {
  yamlText: string;
}

function consoleTheme(): Extension {
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--surface-inset)',
        color: 'var(--text-primary)',
        fontSize: '12px',
        height: '100%',
      },
      '.cm-content': {
        fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        caretColor: 'var(--text-primary)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--surface-inset)',
        color: 'var(--text-tertiary)',
        border: 'none',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--accent-ring) !important',
      },
      '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
      '.cm-panels': {
        backgroundColor: 'var(--surface-elevated)',
        color: 'var(--text-primary)',
        borderBottom: '1px solid var(--border)',
      },
      '.cm-panels input, .cm-panels button, .cm-panels label': {
        fontFamily: 'inherit',
        fontSize: '11px',
        color: 'var(--text-primary)',
      },
      '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)' },
      '.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
    },
    { dark: true }
  );
}

function consoleHighlight(): Extension {
  return syntaxHighlighting(
    HighlightStyle.define([
      // YAML keys carry the brand accent; values stay neutral.
      { tag: tags.definition(tags.propertyName), color: 'var(--brand-teal)' },
      { tag: tags.propertyName, color: 'var(--brand-teal)' },
      { tag: tags.string, color: 'var(--text-secondary)' },
      { tag: tags.number, color: 'var(--brand-magenta-2)' },
      { tag: tags.bool, color: 'var(--brand-magenta-2)' },
      { tag: tags.null, color: 'var(--brand-magenta-2)' },
      { tag: tags.comment, color: 'var(--text-tertiary)', fontStyle: 'italic' },
      { tag: tags.punctuation, color: 'var(--text-tertiary)' },
    ])
  );
}

function previewExtensions(): Extension[] {
  return [
    yaml(),
    consoleTheme(),
    consoleHighlight(),
    search({ top: true }),
    keymap.of(searchKeymap),
    EditorState.readOnly.of(true),
    // editable.of(false) removes the focus surface; restore focusability so
    // Ctrl+F (searchKeymap) works after a click into the preview.
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0' }),
    EditorView.lineWrapping,
  ];
}

export function YamlPreview({ yamlText }: YamlPreviewProps): ReactElement {
  const extensions = useMemo(() => previewExtensions(), []);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = (): void => {
    navigator.clipboard.writeText(yamlText).then(
      () => {
        setCopied('copied');
        setTimeout(() => {
          setCopied('idle');
        }, 1500);
      },
      () => {
        // Clipboard API can be unavailable (permissions, insecure context);
        // surface the failure inline instead of swallowing it.
        setCopied('failed');
        setTimeout(() => {
          setCopied('idle');
        }, 1500);
      }
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
          YAML · read-only
        </span>
        <button
          type="button"
          onClick={copy}
          className="rounded border border-border bg-surface px-2 py-0.5 text-[10.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          {copied === 'idle' ? 'Copy' : copied === 'copied' ? 'Copied ✓' : 'Copy failed'}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          value={yamlText}
          extensions={extensions}
          editable={false}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
          }}
          height="100%"
          style={{ height: '100%' }}
        />
      </div>
    </div>
  );
}
