import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallItem } from './ToolCallItem';
import type { InlineToolCall } from '../primitives/message';
import { StreamContextProvider } from '../lib/stream-context';

const render = (call: InlineToolCall): string =>
  renderToStaticMarkup(
    <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
      <ToolCallItem call={call} timestamp="2026-10-02T10:00:00.000Z" />
    </StreamContextProvider>
  );

describe('ToolCallItem disclosure', () => {
  test('a call with detail to show is toggled by a native button', () => {
    const html = render({ name: 'Bash', input: 'x'.repeat(120) });
    expect(html).toContain('<button type="button" aria-expanded="false"');
  });

  test('a call with no input or output has nothing to toggle', () => {
    expect(render({ name: 'Bash', input: {} })).not.toContain('<button');
  });
});
