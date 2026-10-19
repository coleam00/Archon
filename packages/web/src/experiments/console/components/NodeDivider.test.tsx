import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeDivider } from './NodeDivider';
import type { CostScope, NodeRun } from '../primitives/event';
import { StreamContextProvider } from '../lib/stream-context';

const render = (
  costUsd: number | null | undefined,
  costScope: CostScope = 'own',
  tokens: NodeRun['tokens'] = null
): string =>
  renderToStaticMarkup(
    <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
      <NodeDivider
        nodeId="fan"
        nodeName="fan"
        status="completed"
        durationMs={null}
        timestamp="2026-10-02T10:00:00.000Z"
        costUsd={costUsd}
        costScope={costScope}
        tokens={tokens}
      />
    </StreamContextProvider>
  );

describe('NodeDivider cost', () => {
  test("a node's own spend reads as a plain cost", () => {
    expect(render(0.04, 'own')).toContain('· $0.04');
  });

  test('a scope total is labelled as a total, not as the node spend', () => {
    const html = render(0.04, 'total');
    expect(html).toContain('· total $0.04');
    expect(html).not.toContain('· $0.04');
  });

  test.each(['own', 'total'] as const)('shows reported zero with %s scope', scope => {
    expect(render(0, scope)).toContain(scope === 'total' ? '· total $0.0000' : '· $0.0000');
  });

  test.each([null, undefined, -1, Number.NaN, Infinity, -Infinity])(
    'omits absent or invalid cost %s',
    cost => {
      expect(render(cost)).not.toContain('$');
    }
  );

  test('keeps sub-cent precision', () => {
    expect(render(0.0012)).toContain('· $0.0012');
  });
});

describe('NodeDivider tokens', () => {
  test('shows compact gross input and output alongside cost', () => {
    const html = render(0.04, 'own', {
      input: 12000,
      output: 300,
    });
    expect(html).toContain('· $0.04');
    expect(html).toContain('tokens 12K in / 300 out');
    expect(html).not.toContain('21K');
    expect(html).not.toContain('cache');
    expect(html).not.toContain('total');
  });

  test('known zero usage is visible', () => {
    expect(render(0.04, 'own', { input: 0, output: 0 })).toContain('tokens 0 in / 0 out');
  });

  test('missing usage renders no token segment', () => {
    expect(render(0.04, 'own')).not.toContain('tokens');
  });
});
