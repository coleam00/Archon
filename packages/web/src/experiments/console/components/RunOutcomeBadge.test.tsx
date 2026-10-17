import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  terminalRecord,
  detailFixture,
  type TerminalRecord,
} from '../primitives/run.test-fixtures';
import { RunOutcomeBadge } from './RunOutcomeBadge';

describe('RunOutcomeBadge', () => {
  test('labels a succeeded authored outcome', () => {
    const html = renderToStaticMarkup(<RunOutcomeBadge outcome="succeeded" />);
    expect(html).toContain('Authored outcome: succeeded');
    expect(html).toContain('Outcome: succeeded');
  });

  test('labels a failed authored outcome independently', () => {
    const html = renderToStaticMarkup(<RunOutcomeBadge outcome="failed" />);
    expect(html).toContain('Authored outcome: failed');
    expect(html).toContain('Outcome: failed');
  });

  test('renders nothing for an undeclared outcome', () => {
    expect(renderToStaticMarkup(<RunOutcomeBadge outcome={null} />)).toBe('');
  });
});

describe('RunOutcomeBadge terminal returns', () => {
  for (const outcome of ['succeeded', 'failed'] as const) {
    test(`shows the authored explanation for ${outcome}`, () => {
      const html = renderToStaticMarkup(
        <RunOutcomeBadge
          outcome={outcome}
          terminalRecord={terminalRecord(
            {
              availability: 'available',
              node_id: 'result',
              value: {
                delivered: outcome === 'succeeded',
                summary: 'Already covered by an open PR.',
              },
            },
            outcome
          )}
        />
      );
      expect(html).toContain(`Outcome: ${outcome}`);
      expect(html).toContain('summary');
      expect(html).toContain('Already covered by an open PR.');
      expect(html).not.toContain('delivered');
    });
  }

  test('renders every string field in authored order with exact text and escaped markup', () => {
    const explanation = `  First line\n<script>alert('hello')</script>\n${'long'.repeat(300)}  `;
    const html = renderToStaticMarkup(
      <RunOutcomeBadge
        outcome="failed"
        terminalRecord={terminalRecord({
          availability: 'available',
          node_id: 'result',
          value: {
            identifier: 'ID-123',
            rationale: explanation,
            count: 2,
            delivered: false,
            nested: { summary: 'hidden' },
            blank: ' \n ',
          },
        })}
      />
    );
    expect(html).toContain('ID-123');
    expect(html.indexOf('identifier')).toBeLessThan(html.indexOf('rationale'));
    expect(html).toContain(
      `  First line\n&lt;script&gt;alert(&#x27;hello&#x27;)&lt;/script&gt;\n${'long'.repeat(300)}  `
    );
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).not.toContain('<script>');
    for (const field of ['count', 'delivered', 'nested', 'hidden', 'blank']) {
      expect(html).not.toContain(field);
    }
  });

  const unsupported: (TerminalRecord | null | undefined)[] = [
    undefined,
    null,
    terminalRecord({ availability: 'unavailable', node_id: null, reason: 'not_declared' }),
    terminalRecord({
      availability: 'truncated',
      node_id: 'result',
      spill_path: 'output.json',
      original_bytes: 9000,
    }),
    ...[
      undefined,
      null,
      'plain output',
      2,
      true,
      ['explanation'],
      { nested: { summary: 'hidden' } },
      { count: 2, delivered: false },
      { blank: ' \n ' },
    ].map(value => terminalRecord({ availability: 'available', node_id: 'result', value })),
  ];
  test('keeps exact badge-only markup for absent or unsupported returns', () => {
    const baseline = renderToStaticMarkup(<RunOutcomeBadge outcome="failed" />);
    for (const record of unsupported) {
      expect(
        renderToStaticMarkup(<RunOutcomeBadge outcome="failed" terminalRecord={record} />)
      ).toBe(baseline);
    }
  });

  test('a record does not introduce an undeclared outcome', () => {
    expect(
      renderToStaticMarkup(
        <RunOutcomeBadge outcome={null} terminalRecord={detailFixture.run.terminal_record} />
      )
    ).toBe('');
  });
});
