import { describe, it, expect, mock } from 'bun:test';

// Mock logger before importing module under test
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import type { IWorkflowPlatform } from './deps';
import {
  substituteWorkflowVariables,
  buildPromptWithContext,
  detectCreditExhaustion,
  detectCompletionSignal,
  stripCompletionTags,
  isInlineScript,
  formatSubprocessFailure,
  classifyError,
  safeSendMessage,
  type UnknownErrorTracker,
} from './executor-shared';

describe('substituteWorkflowVariables', () => {
  it('replaces $WORKFLOW_ID with the run ID', () => {
    const { prompt } = substituteWorkflowVariables(
      'Run ID: $WORKFLOW_ID',
      'run-123',
      'hello',
      '/tmp/artifacts',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Run ID: run-123');
  });

  it('replaces $ARTIFACTS_DIR with the resolved path', () => {
    const { prompt } = substituteWorkflowVariables(
      'Save to $ARTIFACTS_DIR/output.txt',
      'run-1',
      'msg',
      '/tmp/artifacts/runs/run-1',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Save to /tmp/artifacts/runs/run-1/output.txt');
  });

  it('replaces $BASE_BRANCH with config value', () => {
    const { prompt } = substituteWorkflowVariables(
      'Merge into $BASE_BRANCH',
      'run-1',
      'msg',
      '/tmp',
      'develop',
      'docs/'
    );
    expect(prompt).toBe('Merge into develop');
  });

  it('throws when $BASE_BRANCH is referenced but empty', () => {
    expect(() =>
      substituteWorkflowVariables('Merge into $BASE_BRANCH', 'run-1', 'msg', '/tmp', '', 'docs/')
    ).toThrow('No base branch could be resolved');
  });

  it('does not throw when $BASE_BRANCH is not referenced and baseBranch is empty', () => {
    const { prompt } = substituteWorkflowVariables(
      'No branch reference here',
      'run-1',
      'msg',
      '/tmp',
      '',
      'docs/'
    );
    expect(prompt).toBe('No branch reference here');
  });

  it('replaces $USER_MESSAGE and $ARGUMENTS with user message', () => {
    const { prompt } = substituteWorkflowVariables(
      'Goal: $USER_MESSAGE. Args: $ARGUMENTS',
      'run-1',
      'add dark mode',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Goal: add dark mode. Args: add dark mode');
  });

  it('replaces $DOCS_DIR with configured path', () => {
    const { prompt } = substituteWorkflowVariables(
      'Check $DOCS_DIR for changes',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'packages/docs-web/src/content/docs'
    );
    expect(prompt).toBe('Check packages/docs-web/src/content/docs for changes');
  });

  it('replaces $DOCS_DIR with default docs/ when default passed', () => {
    const { prompt } = substituteWorkflowVariables(
      'Check $DOCS_DIR for changes',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Check docs/ for changes');
  });

  it('does not affect prompts without $DOCS_DIR', () => {
    const { prompt } = substituteWorkflowVariables(
      'No docs reference here',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'custom/docs/'
    );
    expect(prompt).toBe('No docs reference here');
  });

  it('falls back to docs/ when docsDir is empty string', () => {
    const { prompt } = substituteWorkflowVariables(
      'Check $DOCS_DIR for changes',
      'run-1',
      'msg',
      '/tmp',
      'main',
      ''
    );
    expect(prompt).toBe('Check docs/ for changes');
  });

  it('replaces $CONTEXT when issueContext is provided', () => {
    const { prompt, contextSubstituted } = substituteWorkflowVariables(
      'Fix this: $CONTEXT',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      '## Issue #42\nBug report'
    );
    expect(prompt).toBe('Fix this: ## Issue #42\nBug report');
    expect(contextSubstituted).toBe(true);
  });

  it('replaces $ISSUE_CONTEXT and $EXTERNAL_CONTEXT with issueContext', () => {
    const { prompt } = substituteWorkflowVariables(
      'Issue: $ISSUE_CONTEXT. External: $EXTERNAL_CONTEXT',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      'context-data'
    );
    expect(prompt).toBe('Issue: context-data. External: context-data');
  });

  it('does not treat context variables as prefixes of longer identifiers', () => {
    const { prompt, contextSubstituted } = substituteWorkflowVariables(
      'Context: $CONTEXT. File: $CONTEXT_FILE. External path: $EXTERNAL_CONTEXT_PATH. IssueId: $ISSUE_CONTEXT_ID',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      'context-data'
    );
    expect(prompt).toBe(
      'Context: context-data. File: $CONTEXT_FILE. External path: $EXTERNAL_CONTEXT_PATH. IssueId: $ISSUE_CONTEXT_ID'
    );
    expect(contextSubstituted).toBe(true);
  });

  it('does not substitute $ISSUE_CONTEXT when followed by identifier characters', () => {
    const { prompt } = substituteWorkflowVariables(
      'Issue: $ISSUE_CONTEXT. ID: $ISSUE_CONTEXT_ID. Type: $ISSUE_CONTEXT_TYPE',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      'context-data'
    );
    expect(prompt).toBe('Issue: context-data. ID: $ISSUE_CONTEXT_ID. Type: $ISSUE_CONTEXT_TYPE');
  });

  it('does not set contextSubstituted when only suffix-extended context vars are present', () => {
    const { prompt, contextSubstituted } = substituteWorkflowVariables(
      'Path: $CONTEXT_FILE',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      'context-data'
    );
    // $CONTEXT_FILE is not a context variable — should be left untouched
    expect(prompt).toBe('Path: $CONTEXT_FILE');
    expect(contextSubstituted).toBe(false);
  });

  it('clears context variables when issueContext is undefined', () => {
    const { prompt, contextSubstituted } = substituteWorkflowVariables(
      'Context: $CONTEXT here',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Context:  here');
    expect(contextSubstituted).toBe(false);
  });

  it('replaces $REJECTION_REASON with rejection reason', () => {
    const { prompt } = substituteWorkflowVariables(
      'Fix based on: $REJECTION_REASON',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      undefined,
      'Missing error handling'
    );
    expect(prompt).toBe('Fix based on: Missing error handling');
  });

  it('clears $REJECTION_REASON when not provided', () => {
    const { prompt } = substituteWorkflowVariables(
      'Fix: $REJECTION_REASON',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Fix: ');
  });

  it('replaces $LOOP_PREV_OUTPUT with the previous iteration output', () => {
    const { prompt } = substituteWorkflowVariables(
      'Last pass said:\n$LOOP_PREV_OUTPUT',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      'QA failed: 2 type errors in users.ts'
    );
    expect(prompt).toBe('Last pass said:\nQA failed: 2 type errors in users.ts');
  });

  it('clears $LOOP_PREV_OUTPUT when not provided (first iteration)', () => {
    const { prompt } = substituteWorkflowVariables(
      'Previous output: $LOOP_PREV_OUTPUT (end)',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Previous output:  (end)');
  });

  it('does not affect prompts that omit $LOOP_PREV_OUTPUT', () => {
    const { prompt } = substituteWorkflowVariables(
      'Plain prompt with no loop variable.',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      'unused previous output'
    );
    expect(prompt).toBe('Plain prompt with no loop variable.');
  });
});

describe('buildPromptWithContext', () => {
  it('appends issueContext when no context variable in template', () => {
    const result = buildPromptWithContext(
      'Do the thing',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      '## Issue #42\nDetails here',
      'test prompt'
    );
    expect(result).toContain('Do the thing');
    expect(result).toContain('## Issue #42');
  });

  it('does not append issueContext when $CONTEXT was substituted', () => {
    const result = buildPromptWithContext(
      'Fix this: $CONTEXT',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      '## Issue #42\nDetails here',
      'test prompt'
    );
    // Context was substituted inline, should not be appended again
    const contextCount = (result.match(/## Issue #42/g) ?? []).length;
    expect(contextCount).toBe(1);
  });

  it('returns prompt unchanged when no issueContext provided', () => {
    const result = buildPromptWithContext(
      'Do the thing',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      'test prompt'
    );
    expect(result).toBe('Do the thing');
  });
});

describe('detectCreditExhaustion', () => {
  it('detects "You\'re out of extra usage" (exact SDK phrase)', () => {
    const result = detectCreditExhaustion("You're out of extra usage · resets in 2h");
    expect(result).toBe('Credit exhaustion detected — resume when credits reset');
  });

  it('detects "out of credits" phrase', () => {
    expect(detectCreditExhaustion('Sorry, you are out of credits.')).not.toBeNull();
  });

  it('detects "credit balance" phrase', () => {
    expect(detectCreditExhaustion('Your credit balance is too low.')).not.toBeNull();
  });

  it('returns null for normal output', () => {
    expect(detectCreditExhaustion('Here is the investigation summary...')).toBeNull();
  });

  it('detects "insufficient credit" phrase', () => {
    expect(detectCreditExhaustion('Insufficient credit to continue.')).not.toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectCreditExhaustion("YOU'RE OUT OF EXTRA USAGE")).not.toBeNull();
  });
});

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

  it('detects plain signal at end of output', () => {
    expect(detectCompletionSignal('Work done. COMPLETE', 'COMPLETE')).toBe(true);
  });

  it('detects plain signal on its own line', () => {
    expect(detectCompletionSignal('Work done.\nCOMPLETE\nExtra text', 'COMPLETE')).toBe(true);
  });

  it('does not detect signal embedded in prose', () => {
    expect(detectCompletionSignal('The status is not COMPLETE yet.', 'COMPLETE')).toBe(false);
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
  it('strips the "Command failed: <cmd>" prefix line so the script body does not appear', () => {
    const err = {
      message:
        'Command failed: bun --no-env-file -e import { writeFileSync } from "node:fs"; const x = `hello`;\n' +
        'error: Expected ")" but found "x"\n    at [eval]:1:50',
      stderr: '',
      code: 1,
    };
    const { userMessage } = formatSubprocessFailure(err, "Script node 'n1'");
    expect(userMessage).not.toContain('Command failed:');
    expect(userMessage).not.toContain('writeFileSync'); // script body must not leak
    expect(userMessage).toContain('Expected ")"');
    expect(userMessage).toContain('[eval]:1:50');
    expect(userMessage).toContain('[exit 1]');
  });

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

  it('truncates diagnostics larger than 2 KB from the tail', () => {
    const big = 'x'.repeat(5000) + '\nactual error at end';
    const { userMessage } = formatSubprocessFailure(
      { message: 'Command failed: cmd\n', stderr: big, code: 1 },
      "Script node 'n1'"
    );
    expect(userMessage).toContain('actual error at end');
    expect(userMessage).toContain('[truncated]');
    // Tight bound: ~2 KB diagnostic + label prefix + truncation suffix should fit
    // well under 2.1 KB. Bumping SUBPROCESS_ERROR_MAX_CHARS would trip this.
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

  it('omits the [exit N] suffix when no code is present', () => {
    const { userMessage } = formatSubprocessFailure({ stderr: 'diagnostic' }, "Script node 'n1'");
    expect(userMessage).not.toContain('[exit');
    expect(userMessage).toContain('diagnostic');
  });
});

describe('classifyError', () => {
  it('classifies 429 as TRANSIENT', () => {
    expect(classifyError(new Error('rate limit: 429 too many requests'))).toBe('TRANSIENT');
  });

  it('classifies 529 as TRANSIENT', () => {
    expect(classifyError(new Error('HTTP 529 service overloaded'))).toBe('TRANSIENT');
  });

  it('classifies overloaded messages as TRANSIENT', () => {
    expect(classifyError(new Error('Minimax: overloaded, try again later'))).toBe('TRANSIENT');
  });

  it('classifies 401 as FATAL', () => {
    expect(classifyError(new Error('401 unauthorized'))).toBe('FATAL');
  });

  it('FATAL takes priority over TRANSIENT when both match', () => {
    expect(classifyError(new Error('unauthorized: exited with code 1'))).toBe('FATAL');
  });

  it('classifies unknown errors as UNKNOWN', () => {
    expect(classifyError(new Error('something completely unexpected happened'))).toBe('UNKNOWN');
  });
});

describe('safeSendMessage', () => {
  const makePlatform = (impl: () => Promise<void>) => ({
    sendMessage: mock(impl),
    getPlatformType: mock(() => 'test'),
  });

  it('returns true and resets tracker to 0 on success', async () => {
    const platform = makePlatform(() => Promise.resolve());
    const tracker: UnknownErrorTracker = { count: 5 };
    const result = await safeSendMessage(
      platform as unknown as IWorkflowPlatform,
      'conv-1',
      'hello',
      undefined,
      undefined,
      tracker
    );
    expect(result).toBe(true);
    expect(tracker.count).toBe(0);
  });

  it('returns false on TRANSIENT error without throwing', async () => {
    const platform = makePlatform(() => Promise.reject(new Error('timeout connecting')));
    const result = await safeSendMessage(
      platform as unknown as IWorkflowPlatform,
      'conv-1',
      'hello'
    );
    expect(result).toBe(false);
  });

  it('rethrows FATAL errors', async () => {
    const platform = makePlatform(() => Promise.reject(new Error('unauthorized')));
    await expect(
      safeSendMessage(platform as unknown as IWorkflowPlatform, 'conv-1', 'hello')
    ).rejects.toThrow('Platform authentication/permission error: unauthorized');
  });

  it('increments UNKNOWN tracker and returns false below threshold', async () => {
    const platform = makePlatform(() => Promise.reject(new Error('some unclassified glitch')));
    const tracker: UnknownErrorTracker = { count: 0 };
    const result = await safeSendMessage(
      platform as unknown as IWorkflowPlatform,
      'conv-1',
      'hello',
      undefined,
      undefined,
      tracker
    );
    expect(result).toBe(false);
    expect(tracker.count).toBe(1);
  });

  it('throws after three consecutive UNKNOWN errors', async () => {
    const platform = makePlatform(() => Promise.reject(new Error('some unclassified glitch')));
    const tracker: UnknownErrorTracker = { count: 2 };
    await expect(
      safeSendMessage(
        platform as unknown as IWorkflowPlatform,
        'conv-1',
        'hello',
        undefined,
        undefined,
        tracker
      )
    ).rejects.toThrow('3 consecutive unrecognized errors');
  });

  it('TRANSIENT resets tracker so subsequent UNKNOWN does not trip threshold', async () => {
    // Sequence: UNKNOWN (count→1), TRANSIENT (count→0), UNKNOWN (count→1) — no throw
    const errors = [
      new Error('some unclassified glitch'), // UNKNOWN
      new Error('timeout'), // TRANSIENT
      new Error('some unclassified glitch'), // UNKNOWN
    ];
    let callCount = 0;
    const platform = {
      sendMessage: mock(async () => {
        throw errors[callCount++];
      }),
      getPlatformType: mock(() => 'test'),
    };
    const tracker: UnknownErrorTracker = { count: 0 };

    await safeSendMessage(
      platform as unknown as IWorkflowPlatform,
      'conv-1',
      'msg',
      undefined,
      undefined,
      tracker
    );
    expect(tracker.count).toBe(1);

    await safeSendMessage(
      platform as unknown as IWorkflowPlatform,
      'conv-1',
      'msg',
      undefined,
      undefined,
      tracker
    );
    expect(tracker.count).toBe(0);

    const result = await safeSendMessage(
      platform as unknown as IWorkflowPlatform,
      'conv-1',
      'msg',
      undefined,
      undefined,
      tracker
    );
    expect(result).toBe(false);
    expect(tracker.count).toBe(1);
  });

  it('works correctly without unknownErrorTracker (DAG executor path)', async () => {
    const platform = makePlatform(() => Promise.reject(new Error('some unclassified glitch')));
    // No tracker passed — UNKNOWN errors never throw regardless of call count
    for (let i = 0; i < 5; i++) {
      const result = await safeSendMessage(
        platform as unknown as IWorkflowPlatform,
        'conv-1',
        'hello'
      );
      expect(result).toBe(false);
    }
  });
});
