import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { WhenSection } from '../../../components/when/WhenSection';

afterEach(cleanup);

describe('WhenSection', () => {
  it('renders visual mode by default for a parseable DNF expression', () => {
    render(
      <WhenSection
        value="$classify.output.issue_type == 'bug'"
        upstreamIds={['classify']}
        outputFormatLookup={() => ({
          properties: { issue_type: { type: 'string' } },
        })}
        onChange={() => {}}
      />
    );
    const visual = screen.getByRole('button', { name: /visual/i });
    const raw = screen.getByRole('button', { name: /raw/i });
    expect(visual.getAttribute('aria-pressed')).toBe('true');
    expect(raw.getAttribute('aria-pressed')).toBe('false');
    expect(visual.hasAttribute('disabled')).toBe(false);
  });

  it('forces raw mode and shows banner for non-DNF input (parse error here)', () => {
    // Parens are not in the grammar — this is a parse error, surfaced as
    // "Can't parse" banner. Per drift notes, true non-DNF-inside-AND is
    // structurally unreachable through `parse`.
    render(
      <WhenSection
        value="$a.output == 'x' && ($b.output == 'y' || $c.output == 'z')"
        upstreamIds={['a', 'b', 'c']}
        outputFormatLookup={() => null}
        onChange={() => {}}
      />
    );
    const visual = screen.getByRole('button', { name: /visual/i });
    expect(visual.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent ?? '').toMatch(/can't parse/i);
  });

  it('forces raw mode for parse error and shows banner', () => {
    render(
      <WhenSection
        value="this is not a valid expression"
        upstreamIds={[]}
        outputFormatLookup={() => null}
        onChange={() => {}}
      />
    );
    const visual = screen.getByRole('button', { name: /visual/i });
    expect(visual.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent ?? '').toMatch(/can't parse/i);
  });

  it('starts in visual mode for empty value (DNF: empty OR-of-ANDs)', () => {
    render(
      <WhenSection
        value=""
        upstreamIds={['a']}
        outputFormatLookup={() => null}
        onChange={() => {}}
      />
    );
    const visual = screen.getByRole('button', { name: /visual/i });
    expect(visual.getAttribute('aria-pressed')).toBe('true');
    expect(visual.hasAttribute('disabled')).toBe(false);
  });
});
