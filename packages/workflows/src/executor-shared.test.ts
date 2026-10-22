// @archon-test-isolated
import { providerFailureClassSchema } from '@archon/provider-contract';
import { describe, it, expect } from 'bun:test';

import { redactSubprocessError, runSubprocess, type RawSubprocessRejection } from './subprocess';
import type { NodeOutput } from './schemas';
import { nodeFailureKindSchema } from './schemas/node-execution';
import {
  detectCompletionSignal,
  describeUnmetCompletion,
  stripCompletionTags,
  isInlineScript,
  formatSubprocessFailure,
  retainStreamTail,
  getRetryDelayMs,
  RATE_LIMIT_RETRY_DELAY_MS,
  RATE_LIMIT_PAUSE_DELAY_MS,
  rateLimitResumeAt,
  aggregateProviderFailure,
  rootFailures,
  nodeFailureKindOf,
  retryClassOf,
} from './executor-shared';

describe('isInlineScript', () => {
  // Named identifiers — should return false
  it('plain identifier is not inline', () => {
    expect(isInlineScript('my-script')).toBe(false);
  });

  it('hyphenated name is not inline', () => {
    expect(isInlineScript('fetch-data')).toBe(false);
  });

  it('dot-separated name is not inline', () => {
    expect(isInlineScript('my.script')).toBe(false);
  });

  // Inline code — should return true
  it('newline is inline', () => {
    expect(isInlineScript('a\nb')).toBe(true);
  });

  it('semicolon is inline', () => {
    expect(isInlineScript('a; b')).toBe(true);
  });

  it('parenthesis is inline', () => {
    expect(isInlineScript('f()')).toBe(true);
  });

  it('space is inline', () => {
    expect(isInlineScript('console.log("x")')).toBe(true);
  });

  it('dollar sign is inline', () => {
    expect(isInlineScript('$VAR')).toBe(true);
  });

  it('single-quoted string is inline', () => {
    expect(isInlineScript("print('hi')")).toBe(true);
  });

  it('double-quoted string is inline', () => {
    expect(isInlineScript('print("hi")')).toBe(true);
  });

  // Edge cases
  it('empty string is not inline', () => {
    expect(isInlineScript('')).toBe(false);
  });
});

describe('detectCompletionSignal', () => {
  it('treats signal metacharacters literally in XML detection and stripping', () => {
    const signal = 'DONE.+[x](y)';
    const output = `<done>${signal}</done>`;
    const lookalike = '<done>DONEZxxy</done>';
    expect(detectCompletionSignal(output, signal)).toBe(true);
    expect(detectCompletionSignal(lookalike, signal)).toBe(false);
    expect(stripCompletionTags(`Result ${output}`, signal)).toBe('Result');
    expect(stripCompletionTags(lookalike, signal)).toBe(lookalike);
  });
  it('detects <promise>SIGNAL</promise> format', () => {
    expect(detectCompletionSignal('<promise>COMPLETE</promise>', 'COMPLETE')).toBe(true);
  });

  it('detects signal in custom XML tags: <COMPLETE>SIGNAL</COMPLETE>', () => {
    expect(detectCompletionSignal('<COMPLETE>ALL_CLEAN</COMPLETE>', 'ALL_CLEAN')).toBe(true);
  });

  it('detects signal in other XML tag names', () => {
    expect(detectCompletionSignal('<done>COMPLETE</done>', 'COMPLETE')).toBe(true);
    expect(detectCompletionSignal('<status>DONE</status>', 'DONE')).toBe(true);
  });

  it('detects a plain signal as the final standalone line', () => {
    expect(detectCompletionSignal('Work done.\n  COMPLETE  \n', 'COMPLETE')).toBe(true);
  });

  it('detects a plain signal followed by trailing blank lines and whitespace', () => {
    expect(detectCompletionSignal('Work done.\nCOMPLETE\n\n\n', 'COMPLETE')).toBe(true);
    expect(detectCompletionSignal('Work done.\nCOMPLETE\n   \n\t\n', 'COMPLETE')).toBe(true);
  });

  it('detects a plain signal with CRLF line endings', () => {
    expect(detectCompletionSignal('Work done.\r\nCOMPLETE\r\n', 'COMPLETE')).toBe(true);
  });

  it('does not detect the live incident shape: a negated mention ending the output', () => {
    expect(
      detectCompletionSignal(
        'the story still has open tasks — T8 is now ready, and T9 remains — so not replying ALL_TASKS_COMPLETE.',
        'ALL_TASKS_COMPLETE'
      )
    ).toBe(false);
  });

  it('does not detect a plain signal mentioned inline at the end of output', () => {
    expect(detectCompletionSignal('Work done. COMPLETE', 'COMPLETE')).toBe(false);
  });

  it('does not detect a negated plain signal at the end of output', () => {
    expect(detectCompletionSignal('The status is not COMPLETE', 'COMPLETE')).toBe(false);
  });

  it('does not detect signal when wrong value is in tags', () => {
    expect(detectCompletionSignal('<COMPLETE>WRONG</COMPLETE>', 'ALL_CLEAN')).toBe(false);
  });

  it('does NOT detect signal when XML tag names do not match (strict)', () => {
    // Open/close tag names must agree — guards against AI prose that
    // interleaves tags (e.g. "<COMPLETE>ALL_CLEAN</other-tag>") being
    // treated as a completion.
    expect(detectCompletionSignal('<COMPLETE>ALL_CLEAN</done>', 'ALL_CLEAN')).toBe(false);
  });

  it('detects signal when tag names match case-insensitively', () => {
    expect(detectCompletionSignal('<Complete>ALL_CLEAN</complete>', 'ALL_CLEAN')).toBe(true);
  });
});

describe('stripCompletionTags', () => {
  it('strips <promise> tags', () => {
    expect(stripCompletionTags('Done. <promise>COMPLETE</promise>')).toBe('Done.');
  });

  it('strips XML-wrapped signal when until is provided', () => {
    expect(stripCompletionTags('Done. <COMPLETE>ALL_CLEAN</COMPLETE>', 'ALL_CLEAN')).toBe('Done.');
  });

  it('does not strip XML tags when until is not provided', () => {
    const input = 'Done. <COMPLETE>ALL_CLEAN</COMPLETE>';
    expect(stripCompletionTags(input)).toBe(input.trim());
  });

  it('strips both <promise> and XML-tagged signal when until is provided', () => {
    const input = 'Done. <promise>ALL_CLEAN</promise> <COMPLETE>ALL_CLEAN</COMPLETE>';
    expect(stripCompletionTags(input, 'ALL_CLEAN')).toBe('Done.');
  });
});

describe('formatSubprocessFailure', () => {
  it('uses stderr diagnostics without exposing the command message', () => {
    const err = {
      message:
        'Command failed: bun --no-env-file -e import { writeFileSync } from "node:fs"; const x = `hello`;\n' +
        'error: Expected ")" but found "x"\n    at [eval]:1:50',
      stderr: 'error: Expected ")" but found "x"\n    at [eval]:1:50',
      code: 1,
    };
    const { userMessage } = formatSubprocessFailure(err, "Script node 'n1'");
    expect(userMessage).not.toContain('Command failed:');
    expect(userMessage).not.toContain('writeFileSync'); // script body must not leak
    expect(userMessage).toContain('Expected ")"');
    expect(userMessage).toContain('[eval]:1:50');
    expect(userMessage).toContain('[exit 1]');
  });

  it.each(['', ' \n '])('discards multiline command text when streams are blank (%j)', stream => {
    const { userMessage } = formatSubprocessFailure(
      {
        message: 'Command failed: bun -e // inline-body-marker\nprocess.exit(7);',
        stdout: stream,
        stderr: stream,
        code: 7,
      },
      "Script node 'n1'"
    );
    expect(userMessage).toBe("Script node 'n1' failed [exit 7]: no diagnostic output");
  });

  it.each(['', ' \n '])('keeps command provenance through credential redaction (%j)', stream => {
    const err = redactSubprocessError(
      Object.assign(new Error('Command failed: bun -e // private-body\nprocess.exit(7);'), {
        stdout: stream,
        stderr: stream,
        code: 7,
      }),
      ['failed']
    );
    expect(formatSubprocessFailure(err, 'Script').userMessage).toBe(
      'Script failed [exit 7]: no diagnostic output'
    );
  });

  it('retains useful spawn diagnostics without presenting errno as an exit', () => {
    const err = redactSubprocessError(
      Object.assign(new Error('spawn bun ENOENT'), { code: 'ENOENT' }),
      ['failed']
    );
    const formatted = formatSubprocessFailure(err, 'Script');
    expect(formatted.userMessage).toBe('Script failed [error ENOENT]: spawn bun ENOENT');
    expect(formatted.logFields.exitCode).toBeUndefined();
  });

  it.each(['stdout', 'stderr'] as const)(
    'preserves the cause of a real %s overflow with nonempty output',
    async stream => {
      const error = await runSubprocess(
        { kind: 'host' },
        process.execPath,
        [
          '--no-env-file',
          '-e',
          `// private-body-marker\nprocess.${stream}.write('x'.repeat(2 * 1024 * 1024));`,
        ],
        { cwd: import.meta.dir, env: {}, timeout: 5000, retention: { standalone: true } }
      ).then(
        () => undefined,
        (error: unknown) => error as RawSubprocessRejection
      );
      expect(error?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect(error?.[stream]?.length).toBeGreaterThan(0);
      const { userMessage, logFields } = formatSubprocessFailure(error ?? {}, 'Script');
      expect(userMessage).toContain('[error ERR_CHILD_PROCESS_STDIO_MAXBUFFER]');
      expect(logFields.errorCode).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect(logFields.exitCode).toBeUndefined();
      expect(userMessage).toContain('xxx');
      expect(userMessage).not.toContain('private-body-marker');
      expect(userMessage).not.toContain('Command failed:');
      expect(userMessage.length).toBeLessThan(2100);
    }
  );

  it('prefers stderr over message body when both are present', () => {
    const err = {
      message:
        'Command failed: bash -c long script body that should not appear\nfallback text in message',
      stderr: 'clean diagnostic from stderr',
      code: 2,
    };
    const { userMessage } = formatSubprocessFailure(err, "Bash node 'b1'");
    expect(userMessage).toContain('clean diagnostic from stderr');
    expect(userMessage).not.toContain('long script body');
    expect(userMessage).toContain('[exit 2]');
  });

  it('keeps the tail of diagnostics larger than 2 KB and bounds the output', () => {
    const big = 'x'.repeat(5000) + '\nactual error at end';
    const { userMessage } = formatSubprocessFailure(
      { message: 'Command failed: cmd\n', stderr: big, code: 1 },
      "Script node 'n1'"
    );
    expect(userMessage).toContain('actual error at end');
    // Tight bound: ~2 KB diagnostic + label prefix should fit well under 2.1 KB.
    // Bumping SUBPROCESS_ERROR_MAX_CHARS would trip this.
    expect(userMessage.length).toBeLessThan(2100);
  });

  it('logFields never contain the full message, stack, or cmd', () => {
    const err = {
      message: 'Command failed: bun -e const body = "SECRET_BODY"\n',
      stack: 'Error: Command failed: bun -e const body = "SECRET_BODY"\n    at …',
      cmd: 'bun -e const body = "SECRET_BODY"',
      stderr: 'short stderr',
      code: 1,
    };
    const { logFields } = formatSubprocessFailure(err, "Script node 'n1'");
    const serialized = JSON.stringify(logFields);
    expect(serialized).not.toContain('SECRET_BODY');
    expect(serialized).not.toContain('Command failed:');
    expect(logFields.exitCode).toBe(1);
    expect(logFields.stderrTail).toBe('short stderr');
  });

  it('falls back when stderr is empty and there is no "Command failed:" prefix', () => {
    const err = { message: 'ENOENT: bash not found', code: 127 };
    const { userMessage } = formatSubprocessFailure(err, "Bash node 'b1'");
    expect(userMessage).toContain('ENOENT: bash not found');
    expect(userMessage).toContain('[exit 127]');
  });

  it('handles a completely empty error object without throwing', () => {
    const { userMessage, logFields } = formatSubprocessFailure({}, "Bash node 'b1'");
    expect(userMessage).toContain("Bash node 'b1' failed");
    expect(userMessage).toContain('unknown error');
    expect(logFields.exitCode).toBeUndefined();
    expect(logFields.killed).toBe(false);
    expect(logFields.stderrTail).toBeUndefined();
  });

  it('uses a stdout tail as the diagnostic when stderr is empty', () => {
    const err = {
      message: 'Command failed: bash -c script body\n',
      stdout: 'targeted test failed on repetition 3/5: bun test foo.test.ts',
      code: 1,
    };
    const { userMessage, logFields } = formatSubprocessFailure(err, "Script node 'n1'");
    expect(userMessage).not.toContain('no diagnostic output');
    expect(userMessage).toContain('targeted test failed on repetition 3/5');
    expect(userMessage).toContain('[exit 1]');
    expect(logFields.stdoutTail).toBe(err.stdout);
    expect(logFields.stderrTail).toBeUndefined();
  });

  it('includes labelled stderr and stdout tails when both streams are populated', () => {
    const err = {
      message: 'Command failed: bash -c script body\n',
      stderr: 'error: assertion failed',
      stdout: 'progress line before failure',
      code: 1,
    };
    const { userMessage, logFields } = formatSubprocessFailure(err, "Script node 'n1'");
    expect(userMessage).toContain('[stderr]');
    expect(userMessage).toContain('error: assertion failed');
    expect(userMessage).toContain('[stdout]');
    expect(userMessage).toContain('progress line before failure');
    expect(logFields.stderrTail).toBe('error: assertion failed');
    expect(logFields.stdoutTail).toBe('progress line before failure');
  });

  it('caps stderr and stdout tails jointly under the existing 2 KB budget', () => {
    const err = {
      message: 'Command failed: cmd\n',
      stderr: 'e'.repeat(1200),
      stdout: 'o'.repeat(5000),
      code: 1,
    };
    const { userMessage, logFields } = formatSubprocessFailure(err, "Script node 'n1'");
    expect(userMessage.length).toBeLessThan(2100);
    expect(userMessage).toContain('[stderr]');
    expect(userMessage).toContain('[stdout]');
    const { stderrTail, stdoutTail } = logFields;
    expect(typeof stderrTail).toBe('string');
    expect(typeof stdoutTail).toBe('string');
    if (typeof stderrTail !== 'string' || typeof stdoutTail !== 'string')
      throw new Error('tails missing');
    expect(stderrTail.length).toBeLessThanOrEqual(1000);
    expect(stdoutTail.length).toBeLessThanOrEqual(2000 - stderrTail.length);
  });

  it('omits the [exit N] suffix when no code is present', () => {
    const { userMessage } = formatSubprocessFailure({ stderr: 'diagnostic' }, "Script node 'n1'");
    expect(userMessage).not.toContain('[exit');
    expect(userMessage).toContain('diagnostic');
  });
});

describe('getRetryDelayMs', () => {
  it('capacity backoff grows to a capped center with jitter', () => {
    const random = Math.random;
    try {
      Math.random = () => 0.5;
      expect([0, 1, 2, 3, 4].map(i => getRetryDelayMs('overloaded', i, 1))).toEqual([
        45000, 90000, 180000, 300000, 300000,
      ]);
      Math.random = () => 0;
      expect(getRetryDelayMs('overloaded', 0, 1)).toBe(22500);
      expect(getRetryDelayMs('overloaded', 9, 1)).toBe(150000);
      Math.random = () => 1;
      expect(getRetryDelayMs('overloaded', 0, 1)).toBe(67500);
      expect(getRetryDelayMs('overloaded', 9, 1)).toBe(450000);
    } finally {
      Math.random = random;
    }
  });

  it('backs off flat + jitter on rate limits, exponential otherwise — #2706', () => {
    for (let i = 0; i < 20; i++) {
      const delay = getRetryDelayMs('rate_limited', i, 3000);
      expect(delay).toBeGreaterThanOrEqual(RATE_LIMIT_RETRY_DELAY_MS / 2);
      expect(delay).toBeLessThanOrEqual((RATE_LIMIT_RETRY_DELAY_MS * 3) / 2);
    }
    expect(getRetryDelayMs('transient', 0, 3000)).toBe(3000);
    expect(getRetryDelayMs('transient', 2, 3000)).toBe(12000);
  });
});

describe('rateLimitResumeAt', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');

  it("waits for the provider's reported reset while it is still ahead", () => {
    const resetAt = '2026-10-16T12:30:00.000Z';
    expect(rateLimitResumeAt({ class: 'rate_limited', evidence: '429', resetAt }, now)).toBe(
      Date.parse(resetAt)
    );
  });

  it('backs off 5 to 15 minutes without a reset, or once the reported one has passed', () => {
    const random = Math.random;
    try {
      for (const resetAt of [undefined, '2026-10-16T11:59:00.000Z']) {
        const failure = { class: 'rate_limited' as const, evidence: '429', resetAt };
        Math.random = () => 0;
        expect(rateLimitResumeAt(failure, now)).toBe(now + RATE_LIMIT_PAUSE_DELAY_MS / 2);
        Math.random = () => 0.999999;
        expect(rateLimitResumeAt(failure, now)).toBe(
          now + Math.round(RATE_LIMIT_PAUSE_DELAY_MS * 1.499999)
        );
      }
    } finally {
      Math.random = random;
    }
  });
});

describe('aggregateProviderFailure', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const sooner = {
    class: 'rate_limited' as const,
    evidence: '429',
    resetAt: '2026-10-16T12:10:00Z',
  };
  const later = {
    class: 'quota_exhausted' as const,
    evidence: 'session limit',
    resetAt: '2026-10-16T13:00:00Z',
  };

  it('reports a lone failed descendant unchanged, whatever its class', () => {
    const auth = { class: 'auth' as const, evidence: 'bad key' };
    expect(aggregateProviderFailure([auth], now)).toBe(auth);
    expect(aggregateProviderFailure([undefined], now)).toBeUndefined();
  });

  it('reports nothing when a provider limit sits beside any other failure', () => {
    expect(aggregateProviderFailure([sooner, undefined], now)).toBeUndefined();
    expect(
      aggregateProviderFailure([later, { class: 'transient', evidence: 'socket hang up' }], now)
    ).toBeUndefined();
  });

  it('reports the latest resume deadline among several limits, and a resetless usage limit over any', () => {
    const noReset = { class: 'rate_limited' as const, evidence: '429' };
    expect(aggregateProviderFailure([noReset, sooner, later], now)).toBe(later);
    const unwaitable = { class: 'quota_exhausted' as const, evidence: 'session limit' };
    expect(aggregateProviderFailure([later, unwaitable], now)).toBe(unwaitable);
  });

  it('ranks a resetless rate limit by its backoff, so an expired usage limit beside it still waits', () => {
    const noReset = { class: 'rate_limited' as const, evidence: '429' };
    const expired = {
      class: 'quota_exhausted' as const,
      evidence: 'session limit',
      resetAt: '2026-10-16T11:00:00Z',
    };
    expect(aggregateProviderFailure([expired, noReset], now)).toBe(noReset);
    expect(aggregateProviderFailure([noReset, expired], now)).toBe(noReset);
  });
});

describe('rootFailures', () => {
  it('drops failures downstream of another failure, through skipped nodes and beside a healthy dependency, and keeps independent ones', () => {
    const failed = (error: string): NodeOutput => ({ state: 'failed', output: '', error });
    const outputs = new Map<string, NodeOutput>([
      ['a', failed('limit')],
      ['b', { state: 'skipped', output: '', cause: { kind: 'upstream_failed', origin: 'a' } }],
      ['c', failed('reads $b.output')],
      ['d', failed('own bug')],
      ['h', { state: 'completed', output: 'ok' }],
      ['e', failed('reads $a.output beside a healthy branch')],
    ]);
    const nodes = [
      { id: 'a' },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['b'] },
      { id: 'd' },
      { id: 'h' },
      { id: 'e', depends_on: ['a', 'h'] },
    ];
    expect(rootFailures(nodes, outputs).map(f => f.nodeId)).toEqual(['a', 'd']);
  });
});

describe('typed provider failures decide retry — #3520', () => {
  it('maps every failure class onto a retry kind', () => {
    const kinds = providerFailureClassSchema.options.map(cls =>
      nodeFailureKindOf({ class: cls, evidence: 'x' })
    );
    expect(kinds).toEqual([
      'fatal',
      'fatal',
      'fatal',
      'fatal',
      'rate_limited',
      'overloaded',
      'transient',
      'unknown',
    ]);
  });

  it('a provider kind is its own retry class; a record without a kind is unknown', () => {
    for (const kind of ['fatal', 'transient', 'rate_limited', 'overloaded', 'unknown'] as const) {
      expect(retryClassOf(kind)).toBe(kind);
    }
    expect(retryClassOf(undefined)).toBe('unknown');
  });

  it('gives every failure kind its retry class', () => {
    const classes = Object.fromEntries(
      nodeFailureKindSchema.options.map(kind => [kind, retryClassOf(kind)])
    );
    expect(classes).toEqual({
      fatal: 'fatal',
      transient: 'transient',
      unknown: 'unknown',
      rate_limited: 'rate_limited',
      overloaded: 'overloaded',
      timeout: 'transient',
      exec_failed: 'unknown',
      output_contract: 'unknown',
      max_iterations: 'unknown',
      child_failed: 'unknown',
      cancelled: 'fatal',
      config: 'fatal',
    });
  });
});

describe('describeUnmetCompletion', () => {
  // The max-iterations failure message for both loop variants. `loop.until` is
  // optional (#2563), so this exists to stop the two executors describing the same
  // loop differently — and to stop either printing `undefined` at the author.
  it('names the signal when only until is declared', () => {
    expect(describeUnmetCompletion({ until: 'COMPLETE' })).toBe(
      "without completion signal 'COMPLETE'"
    );
  });

  it('names the check when only until_bash is declared', () => {
    expect(describeUnmetCompletion({ until_bash: 'bun run test' })).toBe(
      "without a passing 'until_bash' check"
    );
  });

  it('names both when both are declared', () => {
    expect(describeUnmetCompletion({ until: 'DONE', until_bash: 'test -f x' })).toBe(
      "without completion signal 'DONE' or a passing 'until_bash' check"
    );
  });

  it('never emits the literal "undefined" for a channel-less control', () => {
    // Unreachable through the schema (it requires at least one channel), but this is
    // an error message: degrade to something readable rather than assert.
    const described = describeUnmetCompletion({});
    expect(described).toBe('without a completion channel');
    expect(described).not.toContain('undefined');
  });
});

describe('retainStreamTail', () => {
  it('returns a stream at the exact budget whole and unmarked', () => {
    // The boundary an off-by-one would move: 2000 characters is retained in full, so a
    // reader never sees a truncation marker on output that was not truncated.
    const exact = 'y'.repeat(2000);
    expect(retainStreamTail(exact)).toBe(exact);
  });

  it('keeps the tail and marks the dropped head one character over budget', () => {
    const overBudget = `HEAD${'y'.repeat(2000)}`;
    const retained = retainStreamTail(overBudget);
    expect(retained).toBe(`…[truncated to last 2000 chars]\n${'y'.repeat(2000)}`);
    expect(retained).not.toContain('HEAD');
  });

  it('reports an empty or whitespace-only stream as absent, not as an empty string', () => {
    // `undefined` is what makes an absent tail field mean "this stream was empty"
    // rather than "retention did not happen".
    expect(retainStreamTail('')).toBeUndefined();
    expect(retainStreamTail('   \n  ')).toBeUndefined();
    expect(retainStreamTail(undefined)).toBeUndefined();
  });
});
