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

import {
  substituteWorkflowVariables,
  buildPromptWithContext,
  detectCreditExhaustion,
  isInlineScript,
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
