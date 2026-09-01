import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
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
