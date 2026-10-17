import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';
import type { ProviderFailureClass } from '@archon/provider-contract';
import { CLASS_BY_VARIANT, classifyTurnError } from './turn-error';

/** The string literals of the generated `CodexErrorInfo` union, which its `| string` hides from the type. */
function generatedStringVariants(): string[] {
  const path = join(import.meta.dir, 'protocol/v2/CodexErrorInfo.ts');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
  const alias = source.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === 'CodexErrorInfo'
  );
  if (alias === undefined || !ts.isUnionTypeNode(alias.type)) {
    throw new Error('CodexErrorInfo.ts no longer declares a union type');
  }
  return alias.type.types.flatMap(member =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : []
  );
}

function snapshot(
  primary: { usedPercent: number; resetsAt: number | null } | null,
  secondary: { usedPercent: number; resetsAt: number | null } | null = null
): RateLimitSnapshot {
  const window = (w: typeof primary) => (w ? { ...w, windowDurationMins: 300 } : null);
  return {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: window(primary),
    secondary: window(secondary),
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  };
}

describe('classifyTurnError', () => {
  test('classifies every string variant the generated protocol declares', () => {
    const generated = generatedStringVariants();
    expect(generated).toContain('unauthorized');
    expect(Object.keys(CLASS_BY_VARIANT).sort()).toEqual(generated.sort());
  });

  test.each([
    ['unauthorized', 'auth'],
    ['usageLimitExceeded', 'quota_exhausted'],
    ['rateLimitExceeded', 'rate_limited'],
    ['serverOverloaded', 'overloaded'],
    ['internalServerError', 'transient'],
    ['flexUnavailable', 'transient'],
    ['sessionBudgetExceeded', 'budget_exceeded'],
    ['contextWindowExceeded', 'unknown'],
    ['badRequest', 'unknown'],
    // What an unsupported model arrives as.
    ['other', 'unknown'],
    // A variant a newer Codex may add.
    ['someFutureVariant', 'unknown'],
    // An inherited property name is not a variant.
    ['constructor', 'unknown'],
  ] satisfies [string, ProviderFailureClass][])('%s is %s', (info, expected) => {
    expect(classifyTurnError(info, undefined).failureClass).toBe(expected);
  });

  test.each([
    ['httpConnectionFailed', 401, 'auth'],
    ['responseStreamConnectionFailed', 403, 'auth'],
    ['responseStreamDisconnected', 429, 'rate_limited'],
    ['responseTooManyFailedAttempts', 503, 'transient'],
    ['httpConnectionFailed', null, 'transient'],
    ['httpConnectionFailed', 400, 'unknown'],
  ] satisfies [string, number | null, ProviderFailureClass][])(
    '%s with status %p is %s',
    (variant, httpStatusCode, expected) => {
      expect(classifyTurnError({ [variant]: { httpStatusCode } }, undefined).failureClass).toBe(
        expected
      );
    }
  );

  test.each([
    [
      'an object variant that carries no status',
      { activeTurnNotSteerable: { turnKind: 'review' } },
    ],
    ['an unknown object variant', { futureFailure: { httpStatusCode: 401 } }],
    ['null', null],
  ])('%s is unknown', (_label, info) => {
    expect(classifyTurnError(info, undefined).failureClass).toBe('unknown');
  });

  test('a usage limit resets when its full window does', () => {
    const resetsAt = 1_791_143_381;
    const result = classifyTurnError(
      'usageLimitExceeded',
      snapshot({ usedPercent: 40, resetsAt: resetsAt + 9_000 }, { usedPercent: 100, resetsAt })
    );
    expect(result).toEqual({
      failureClass: 'quota_exhausted',
      resetAt: new Date(resetsAt * 1000).toISOString(),
    });
  });

  test('a usage limit with no full window has no reset time', () => {
    expect(
      classifyTurnError('usageLimitExceeded', snapshot({ usedPercent: 99, resetsAt: 1 }))
    ).toEqual({ failureClass: 'quota_exhausted' });
    expect(classifyTurnError('usageLimitExceeded', undefined)).toEqual({
      failureClass: 'quota_exhausted',
    });
  });
});
