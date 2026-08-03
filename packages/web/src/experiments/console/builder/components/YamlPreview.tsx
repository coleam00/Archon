/**
 * Read-only, syntax-highlighted YAML preview pane. The string itself is
 * produced by the pure `serializeToYaml` (yaml/serialize.ts); this component
 * only renders it.
 *
 * Highlighting reuses the console's existing `react-markdown` + `rehype-highlight`
 * stack (the same one `ArtifactPanel`/`MessageItem` use; highlight.js theme is
 * imported globally in `index.css`) rather than adding a second highlighting
 * engine. Deps don't revert when the experiment folder is deleted, so the
 * builder deliberately reuses what's already in the web bundle. The preview is
 * read-only through PR-3; if it ever goes editable, a real editor (CodeMirror)
 * can be reintroduced then as a deliberate, justified dependency.
 */
import { useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

const REHYPE_PLUGINS = [rehypeHighlight];

interface YamlPreviewProps {
  yamlText: string;
}

/**
 * Wrap the serialized YAML in a fenced code block so `rehype-highlight` applies
 * the `language-yaml` grammar. The fence length is computed to exceed the
 * longest backtick run in the content, so a `prompt:` value that itself contains
 * a Markdown code fence can never break out of the block.
 */
function toYamlFence(yamlText: string): string {
  const longestRun = (yamlText.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}yaml\n${yamlText}\n${fence}`;
}

export function YamlPreview({ yamlText }: YamlPreviewProps): ReactElement {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = (): void => {
    const settle = (next: 'copied' | 'failed'): void => {
      setCopied(next);
      setTimeout(() => {
        setCopied('idle');
      }, 1500);
    };
    // Calling writeText inside the .then callback funnels BOTH failure modes
    // into the rejection handler: an async rejection (permissions) AND the
    // synchronous TypeError thrown when `navigator.clipboard` is undefined
    // (insecure context / unsupported browser). Surfaced inline, never swallowed.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(yamlText))
      .then(
        () => {
          settle('copied');
        },
        () => {
          settle('failed');
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
      {/* The global `.hljs` rule paints the code background with --surface; the
          arbitrary child selectors make the generated <pre> fill + scroll the
          pane and drop react-markdown's default block margins. */}
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-relaxed [&_pre]:m-0 [&_pre]:min-h-full [&_pre]:p-3 [&_pre_code]:!bg-transparent">
        <ReactMarkdown rehypePlugins={REHYPE_PLUGINS}>{toYamlFence(yamlText)}</ReactMarkdown>
      </div>
    </div>
  );
}
