import type { ReactElement } from 'react';
import { Panel } from '../document';

/**
 * Code on a panel with its line numbers (owner change 7 of 2026-11-21: a script step shows its
 * script so). Long lines wrap under their own number rather than scroll sideways out of sight.
 */
export function CodePanel({ code, label }: { code: string; label: string }): ReactElement {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <Panel>
      <ol
        aria-label={label}
        className="flex flex-col overflow-hidden py-3 font-mono text-console-13 leading-relaxed"
      >
        {lines.map((line, index) => (
          <li key={index} className="flex min-w-0 gap-4 px-4">
            <span
              aria-hidden="true"
              className="w-8 shrink-0 select-none text-right tabular-nums text-text-tertiary"
            >
              {index + 1}
            </span>
            <code className="min-w-0 whitespace-pre-wrap text-text-primary [overflow-wrap:anywhere]">
              {line === '' ? ' ' : line}
            </code>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
