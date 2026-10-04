import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeDivider } from './NodeDivider';
import type { CostScope } from '../primitives/event';
import { StreamContextProvider } from '../lib/stream-context';

const render = (costScope: CostScope): string =>
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
