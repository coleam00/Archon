import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeDivider } from './NodeDivider';
import type { CostScope, NodeRun } from '../primitives/event';
import { StreamContextProvider } from '../lib/stream-context';

const render = (costScope: CostScope, tokens: NodeRun['tokens'] = null): string =>
  renderToStaticMarkup(
    <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
      <NodeDivider
        nodeId="fan"
        nodeName="fan"
        status="completed"
        durationMs={null}
        timestamp="2026-10-02T10:00:00.000Z"
        costUsd={0.04}
        costScope={costScope}
        tokens={tokens}
      />
    </StreamContextProvider>
  );

describe('NodeDivider cost', () => {
  test("a node's own spend reads as a plain cost", () => {
    expect(render('own')).toContain('· $0.04');
  });

  test('a scope total is labelled as a total, not as the node spend', () => {
    const html = render('total');
    expect(html).toContain('· total $0.04');
    expect(html).not.toContain('· $0.04');
  });
});

describe('NodeDivider tokens', () => {
  test('shows compact gross input and output alongside cost', () => {
    const html = render('own', {
      input: 12000,
      output: 300,
      cacheRead: 8000,
      cacheWrite: 1000,
      cachePartial: true,
    });
    expect(html).toContain('· $0.04');
    expect(html).toContain('tokens 12K in / 300 out');
    expect(html).not.toContain('21K');
    expect(html).not.toContain('cache');
    expect(html).not.toContain('total');
  });

  test('known zero usage is visible', () => {
    expect(render('own', { input: 0, output: 0 })).toContain('tokens 0 in / 0 out');
  });

  test('missing usage renders no token segment', () => {
    expect(render('own')).not.toContain('tokens');
  });
});
