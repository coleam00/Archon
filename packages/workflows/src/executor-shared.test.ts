import { providerFailureClassSchema } from '@archon/provider-contract';
import { describe, it, expect, mock, type Mock } from 'bun:test';

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
import { nodeFailureKindSchema } from './schemas/node-execution';
import {
  substituteWorkflowVariables,
  buildPromptWithContext,
  detectCompletionSignal,
  describeUnmetCompletion,
  stripCompletionTags,
  isInlineScript,
  formatSubprocessFailure,
  retainStreamTail,
  getRetryDelayMs,
  RATE_LIMIT_RETRY_DELAY_MS,
  nodeFailureKindOf,
  retryClassOf,
  safeSendMessage,
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

  it('replaces $STATE_DIR with the resolved state directory', () => {
    const { prompt } = substituteWorkflowVariables(
      'Read $STATE_DIR/triage-state.json',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { stateDir: '/home/u/.archon/workspaces/acme/widget/state' }
    );
    expect(prompt).toBe('Read /home/u/.archon/workspaces/acme/widget/state/triage-state.json');
  });

  it('replaces $STATE_DIR even under shellSafe (engine-controlled, like $ARTIFACTS_DIR)', () => {
    const { prompt } = substituteWorkflowVariables(
      'cat "$STATE_DIR/pr-state.json"',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { shellSafe: true, stateDir: '/state/root' }
    );
    expect(prompt).toBe('cat "/state/root/pr-state.json"');
  });

  // $ADOPTED_RUN_DIR (#2747): resolves only under an explicit adoption; a run
  // that references it without one throws instead of substituting empty.
  it('replaces $ADOPTED_RUN_DIR with the adopted run artifact directory', () => {
    const { prompt } = substituteWorkflowVariables(
      'Read $ADOPTED_RUN_DIR/report.md',
      'run-2',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptedRunDir: '/root/artifacts/runs/run-1' }
    );
    expect(prompt).toBe('Read /root/artifacts/runs/run-1/report.md');
  });

  it('throws when $ADOPTED_RUN_DIR is referenced without an adoption active', () => {
    expect(() =>
      substituteWorkflowVariables(
        'Read $ADOPTED_RUN_DIR/report.md',
        'run-2',
        'msg',
        '/tmp/artifacts',
        'main',
        'docs/'
      )
    ).toThrow(/did not adopt a prior run/);
  });

  it("replaces $TYPED_ARTIFACTS_FILE with this invocation's listing", () => {
    const { prompt } = substituteWorkflowVariables(
      'Read $TYPED_ARTIFACTS_FILE',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { typedArtifactsFile: '/tmp/artifacts/.archon/typed-artifacts/list.json' }
    );
    expect(prompt).toBe('Read /tmp/artifacts/.archon/typed-artifacts/list.json');
  });

  it('replaces $TYPED_ARTIFACTS_FILE even under shellSafe (engine-controlled)', () => {
    const { prompt } = substituteWorkflowVariables(
      'cat "$TYPED_ARTIFACTS_FILE"',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { shellSafe: true, typedArtifactsFile: '/listings/l.json' }
    );
    expect(prompt).toBe('cat "/listings/l.json"');
  });

  it('throws when $TYPED_ARTIFACTS_FILE is referenced without a materialized listing', () => {
    expect(() =>
      substituteWorkflowVariables(
        'Read $TYPED_ARTIFACTS_FILE',
        'run-1',
        'msg',
        '/tmp/artifacts',
        'main',
        'docs/'
      )
    ).toThrow(/has no typed-artifact listing/);
  });

  it('treats an explicit empty listing as a caller stating it has none (dry run)', () => {
    const { prompt } = substituteWorkflowVariables(
      'Read [$TYPED_ARTIFACTS_FILE]',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { typedArtifactsFile: '' }
    );
    expect(prompt).toBe('Read []');
  });

  it('leaves the INPUTS_ variable of an input named typed_artifacts_file alone', () => {
    const { prompt } = substituteWorkflowVariables(
      'Use $INPUTS_TYPED_ARTIFACTS_FILE',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Use $INPUTS_TYPED_ARTIFACTS_FILE');
  });

  it('throws when $STATE_DIR is referenced but no state dir was resolved', () => {
    expect(() =>
      substituteWorkflowVariables(
        'Write $STATE_DIR/x.json',
        'run-1',
        'msg',
        '/tmp/artifacts',
        'main',
        'docs/'
      )
    ).toThrow('$STATE_DIR is referenced but no state directory was resolved');
  });

  it('does not throw when $STATE_DIR is not referenced and no state dir is supplied', () => {
    const { prompt } = substituteWorkflowVariables(
      'No state reference here',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/'
    );
    expect(prompt).toBe('No state reference here');
  });

  it('substitutes a known $INPUTS.<name> from options.inputs (#2470)', () => {
    const { prompt } = substituteWorkflowVariables(
      'Plan: $INPUTS.plan and mode $INPUTS.mode',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { inputs: { plan: 'do the thing', mode: 'fast' } }
    );
    expect(prompt).toBe('Plan: do the thing and mode fast');
  });

  it('throws with a did-you-mean hint on an unknown $INPUTS name (#2470)', () => {
    expect(() =>
      substituteWorkflowVariables(
        'Use $INPUTS.pln',
        'run-1',
        'msg',
        '/tmp/artifacts',
        'main',
        'docs/',
        undefined,
        undefined,
        undefined,
        undefined,
        { inputs: { plan: 'x' } }
      )
    ).toThrow('$INPUTS.plan');
  });

  it('does NOT substitute $INPUTS under shellSafe — env delivery is the shell path (#2470/#2115)', () => {
    const { prompt } = substituteWorkflowVariables(
      'echo "$INPUTS.plan"',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { shellSafe: true, inputs: { plan: 'x' } }
    );
    expect(prompt).toBe('echo "$INPUTS.plan"');
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

  it('skips user-controlled variables when shellSafe is true', () => {
    const { prompt } = substituteWorkflowVariables(
      'echo $USER_MESSAGE $ARGUMENTS $LOOP_USER_INPUT $REJECTION_REASON $LOOP_PREV_OUTPUT $CONTEXT',
      'run-1',
      'dangerous; rm -rf /',
      '/tmp',
      'main',
      'docs/',
      'issue-context',
      'loop-input',
      'rejection',
      'prev-output',
      { shellSafe: true }
    );
    expect(prompt).toBe(
      'echo $USER_MESSAGE $ARGUMENTS $LOOP_USER_INPUT $REJECTION_REASON $LOOP_PREV_OUTPUT $CONTEXT'
    );
  });

  it('still replaces system-controlled variables when shellSafe is true', () => {
    const { prompt } = substituteWorkflowVariables(
      'cd $ARTIFACTS_DIR && git checkout $BASE_BRANCH # $WORKFLOW_ID $DOCS_DIR',
      'run-1',
      'msg',
      '/tmp/artifacts',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      undefined,
      { shellSafe: true }
    );
    expect(prompt).toBe('cd /tmp/artifacts && git checkout main # run-1 docs/');
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

  it('forwards the stateDir option through to $STATE_DIR substitution', () => {
    const result = buildPromptWithContext(
      'Read $STATE_DIR/notes.md',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      'test prompt',
      { stateDir: '/state/root' }
    );
    expect(result).toBe('Read /state/root/notes.md');
  });

  it('throws when $STATE_DIR is referenced and no stateDir option is forwarded', () => {
    expect(() =>
      buildPromptWithContext(
        'Read $STATE_DIR/notes.md',
        'run-1',
        'msg',
        '/tmp',
        'main',
        'docs/',
        undefined,
        'test prompt'
      )
    ).toThrow('$STATE_DIR is referenced but no state directory was resolved');
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

describe('safeSendMessage', () => {
  const platformThat = (send: () => Promise<void>): IWorkflowPlatform =>
    ({
      sendMessage: mock(send),
      getPlatformType: mock(() => 'test'),
    }) as unknown as IWorkflowPlatform;

  it('returns true when the platform accepts the message', async () => {
    expect(
      await safeSendMessage(
        platformThat(() => Promise.resolve()),
        'conv-1',
        'hello'
      )
    ).toBe(true);
  });

  it('logs and suppresses a send failure whatever it says', async () => {
    for (const message of ['401 unauthorized', 'timeout connecting', 'some unclassified glitch']) {
      mockLogFn.mockClear();
      const sent = await safeSendMessage(
        platformThat(() => Promise.reject(new Error(message))),
        'conv-1',
        'hello'
      );
      expect(sent).toBe(false);
      expect(
        (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
          call => call[1] === 'platform_message_send_failed'
        )
      ).toBe(true);
    }
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
