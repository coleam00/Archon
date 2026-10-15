import { describe, test, expect } from 'bun:test';
import { classifyAndFormatError, formatProviderFailure } from './error-formatter';
import { WorkflowAdoptionError } from '../operations/workflow-adoption';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import { buildAiProfile, resolveTierWithFallback } from '@archon/workflows/model-validation';
import { MissingProjectDirectoryError } from '@archon/isolation';

describe('classifyAndFormatError', () => {
  test.each([
    'Failed to load workflow: node "session-review" has an invalid depends_on',
    'lock timeout on .git/index.lock',
    'Invalid config: database.url must be a string',
  ])('preserves the untyped diagnostic: %s', message => {
    expect(classifyAndFormatError(new Error(message))).toBe(`⚠️ Error: ${message}`);
  });

  test('delivers missing project directory guidance verbatim', () => {
    const path = '/home/operator/.archon/workspaces/acme/session-timeout/source';
    const error = new MissingProjectDirectoryError(path, 'acme/session-timeout');
    const result = classifyAndFormatError(error);
    expect(result).toBe(`⚠️ ${error.message}`);
    expect(result).toContain(path);
    expect(result).toContain('acme/session-timeout');
    expect(result).not.toContain('/reset');
    expect(result).not.toContain('network');
  });

  test.each([
    'unexpected EOF',
    'missing key in config',
    'rate limit exceeded',
    'Not logged in',
    'authentication_error',
    'connect ETIMEDOUT 1.2.3.4:443',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'x'.repeat(1000),
  ])('preserves safe diagnostics without inferred advice: %s', message => {
    expect(classifyAndFormatError(new Error(message))).toBe(`⚠️ Error: ${message}`);
  });

  test.each([
    '',
    '   ',
    'wrong password supplied',
    'invalid TOKEN abc123',
    'bad Secret value',
    'api_KEY=sensitive',
    'API key unknown-value',
    'api KEY unknown-value',
  ])('suppresses empty or credential-bearing details: %s', message => {
    expect(classifyAndFormatError(new Error(message))).toBe('⚠️ An unexpected error occurred.');
  });

  test.each(['password', 'token', 'secret', 'key=', 'api key'])(
    'suppresses credentials even when redaction would erase the marker: %s',
    marker => {
      const previous = process.env.ARCHON_FORMATTER_TEST_SECRET;
      process.env.ARCHON_FORMATTER_TEST_SECRET = marker;
      try {
        expect(classifyAndFormatError(new Error(`invalid ${marker} abc123`))).toBe(
          '⚠️ An unexpected error occurred.'
        );
      } finally {
        if (previous === undefined) delete process.env.ARCHON_FORMATTER_TEST_SECRET;
        else process.env.ARCHON_FORMATTER_TEST_SECRET = previous;
      }
    }
  );

  test('redacts known credentials even without their key names', () => {
    const previous = process.env.ARCHON_FORMATTER_TEST_TOKEN;
    process.env.ARCHON_FORMATTER_TEST_TOKEN = 'private-credential-value';
    try {
      expect(
        classifyAndFormatError(new Error('Rejected private-credential-value by upstream'))
      ).toBe('⚠️ Error: Rejected [REDACTED] by upstream');
    } finally {
      if (previous === undefined) delete process.env.ARCHON_FORMATTER_TEST_TOKEN;
      else process.env.ARCHON_FORMATTER_TEST_TOKEN = previous;
    }
  });

  describe('workflow adoption refusals', () => {
    // Adoption refusals are authored guidance (fail-loud contract, #2747 R9); they
    // must reach chat/web users verbatim instead of the generic fallback.
    test('delivers a WorkflowAdoptionError message verbatim', () => {
      const refusal =
        "Cannot adopt run 'prior-run': this conversation already continues run 'x' (paused).";
      const result = classifyAndFormatError(new WorkflowAdoptionError(refusal));
      expect(result).toBe(`⚠️ ${refusal}`);
    });
  });

  describe('terminal status write failures', () => {
    // #2910: this is the terminus for the orchestrator's /invoke-workflow and
    // /workflow run dispatch paths — neither has a closer catch, so handleMessage's
    // catch formats the error here. The retained run needs status recovery guidance.
    test('names the unrecorded status instead of the generic fallback', () => {
      const result = classifyAndFormatError(
        new TerminalStatusWriteError(new Error('SQLITE_BUSY: database is locked'))
      );
      expect(result).toContain('final status could not be saved');
      expect(result).toContain('/workflow status');
      expect(result).not.toContain('/reset');
    });

    test('spells the status command for the surface', () => {
      const result = classifyAndFormatError(new TerminalStatusWriteError(new Error('gone')), {
        formatWorkflowCommand: command => `/archon-workflow ${command}`,
      });
      expect(result).toContain('`/archon-workflow status`');
      expect(result.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
    });

    test('an ordinary database error retains its own diagnostic', () => {
      const result = classifyAndFormatError(new Error('database is locked'));
      expect(result).toBe('⚠️ Error: database is locked');
    });
  });
});

describe('TierResolutionError', () => {
  test('delivers the real tier-resolution guidance verbatim (never the generic fallback)', () => {
    // The actual error the chat path hits when the default provider ships no
    // built-in tiers and none are configured — derived, not restated.
    let thrown: Error | undefined;
    try {
      resolveTierWithFallback(buildAiProfile('pi'), 'large');
    } catch (err) {
      thrown = err as Error;
    }
    if (!thrown) throw new Error('expected resolveTierWithFallback to throw');

    const formatted = classifyAndFormatError(thrown);
    expect(formatted).toBe(`⚠️ ${thrown.message}`);
    expect(formatted).toContain('archon ai tier set');
    expect(formatted).toContain('https://archon.diy/');
    expect(formatted).not.toContain('/reset');
  });
});

describe('formatProviderFailure', () => {
  test.each([
    ['auth', 'The AI provider rejected its credentials: Invalid API key'],
    ['quota_exhausted', 'AI usage limit reached. Please wait and try again.'],
    ['budget_exceeded', 'The turn stopped at its spend limit.'],
    [
      'misconfigured',
      'The AI provider is not set up correctly: Invalid API key. Fix its configuration',
    ],
    ['rate_limited', 'The AI provider is rate limiting requests.'],
    ['overloaded', 'The AI provider is at capacity'],
    ['transient', 'The AI provider failed temporarily: Invalid API key. Try again.'],
    ['unknown', 'AI error: Invalid API key. Try /reset if issue persists.'],
  ] as const)('%s failures get their own advice', (failureClass, expected) => {
    expect(formatProviderFailure({ class: failureClass, evidence: 'Invalid API key' })).toContain(
      expected
    );
  });

  test('the class picks the advice, never the words', () => {
    // Words that read as a usage limit do not turn an auth failure into usage advice.
    const message = formatProviderFailure({
      class: 'auth',
      evidence: 'rate limit reached, usage limit, session limit',
    });
    expect(message).toStartWith('⚠️ The AI provider rejected its credentials');
    expect(message).not.toContain('AI usage limit reached');
  });

  test('names the reset instant of an exhausted quota', () => {
    expect(
      formatProviderFailure({
        class: 'quota_exhausted',
        evidence: "You've hit your session limit",
        resetAt: '2026-09-25T18:00:00.000Z',
      })
    ).toBe(
      '⚠️ AI usage limit reached (resets 2026-09-25T18:00:00.000Z). Please wait and try again.'
    );
  });

  test.each(['password', 'token', 'secret', 'key='])(
    'never shows evidence carrying a shared credential marker: %s',
    marker => {
      const message = formatProviderFailure({ class: 'unknown', evidence: `bad ${marker} abc123` });
      expect(message).toBe('⚠️ AI error. Try /reset if issue persists.');
    }
  );
});
