import { describe, it, expect } from 'bun:test';
import { decideMarketplace, type DecideInput } from '../marketplace-decide.ts';

// A clean baseline: in-scope, not draft, no scan findings, one valid workflow,
// AI recommends auto_merge. Individual tests override one axis at a time.
function base(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    scopeOk: true,
    isDraft: false,
    scan: { severity: 'none', findings: [] },
    schema: { valid: true, files: [{ valid: true }] },
    ai: { recommendation: 'auto_merge', reasoning: 'looks good' },
    ...overrides,
  };
}

describe('decideMarketplace: reject branches + close policy', () => {
  it('scope violation -> reject, close TRUE (deterministic)', () => {
    const r = decideMarketplace(base({ scopeOk: false }));
    expect(r.decision).toBe('reject');
    expect(r.close).toBe(true);
    expect(r.reason).toContain('marketplace.ts');
  });

  it('critical scan -> reject, close TRUE (deterministic)', () => {
    const r = decideMarketplace(base({ scan: { severity: 'critical', findings: [{ category: 'rce', context: 'x.ts' }] } }));
    expect(r.decision).toBe('reject');
    expect(r.close).toBe(true);
    expect(r.reason).toContain('rce in x.ts');
  });

  it('high scan -> reject, close TRUE (deterministic)', () => {
    const r = decideMarketplace(base({ scan: { severity: 'high', findings: [] } }));
    expect(r.decision).toBe('reject');
    expect(r.close).toBe(true);
  });

  it('AI-only reject (clean scan/scope) -> reject, close FALSE (stays open)', () => {
    const r = decideMarketplace(base({ ai: { recommendation: 'reject', reasoning: 'subtle concern' } }));
    expect(r.decision).toBe('reject');
    expect(r.close).toBe(false);
    expect(r.reason).toBe('subtle concern');
  });

  it('high scan wins over an AI auto_merge and closes', () => {
    const r = decideMarketplace(base({ scan: { severity: 'high', findings: [] }, ai: { recommendation: 'auto_merge' } }));
    expect(r.decision).toBe('reject');
    expect(r.close).toBe(true);
  });
});

describe('decideMarketplace: request_changes branches (never close)', () => {
  it('draft -> request_changes', () => {
    const r = decideMarketplace(base({ isDraft: true }));
    expect(r.decision).toBe('request_changes');
    expect(r.close).toBe(false);
  });

  it('empty workflow files -> request_changes (fail-open guard)', () => {
    const r = decideMarketplace(base({ schema: { valid: true, files: [] } }));
    expect(r.decision).toBe('request_changes');
    expect(r.close).toBe(false);
    expect(r.reason).toContain('no workflow YAML');
  });

  it('undefined files list -> request_changes (treated as empty)', () => {
    const r = decideMarketplace(base({ schema: { valid: true } }));
    expect(r.decision).toBe('request_changes');
  });

  it('schema invalid with non-empty files -> request_changes', () => {
    const r = decideMarketplace(base({ schema: { valid: false, files: [{ valid: false }] } }));
    expect(r.decision).toBe('request_changes');
    expect(r.reason).toContain('schema validation');
  });

  it('medium scan -> request_changes', () => {
    const r = decideMarketplace(base({ scan: { severity: 'medium', findings: [] } }));
    expect(r.decision).toBe('request_changes');
  });

  it('AI request_changes -> request_changes', () => {
    const r = decideMarketplace(base({ ai: { recommendation: 'request_changes', reasoning: 'fix it' } }));
    expect(r.decision).toBe('request_changes');
    expect(r.reason).toBe('fix it');
  });
});

describe('decideMarketplace: merge/approve branches', () => {
  it('clean + AI auto_merge -> auto_merge', () => {
    expect(decideMarketplace(base()).decision).toBe('auto_merge');
  });

  it('clean + AI auto_approve (scan none) -> auto_merge (per existing rule)', () => {
    const r = decideMarketplace(base({ ai: { recommendation: 'auto_approve', reasoning: 'ok' } }));
    expect(r.decision).toBe('auto_merge');
  });

  it('low scan + AI auto_merge -> auto_approve (else branch)', () => {
    const r = decideMarketplace(base({ scan: { severity: 'low', findings: [] }, ai: { recommendation: 'auto_merge' } }));
    expect(r.decision).toBe('auto_approve');
    expect(r.close).toBe(false);
  });
});

describe('decideMarketplace: reason never undefined (avoids "null" in PR comments)', () => {
  it('falls back to a placeholder when AI omits reasoning', () => {
    const r = decideMarketplace(base({ ai: { recommendation: 'auto_merge' } }));
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
