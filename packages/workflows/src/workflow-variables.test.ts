// @archon-test-isolated
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

import { substituteWorkflowVariables, buildPromptWithContext } from './workflow-variables';
import { buildExecNodeEnvironment, EXEC_NODE_ENVIRONMENT_NAMES } from './exec-environment';
import {
  USER_CONTROLLED_VARIABLES,
  type UserControlledVariableContext,
} from './user-controlled-variables';

describe('user-controlled runtime variable delivery', () => {
  for (const populated of [true, false]) {
    it(`preserves every declared variable across prompt and env delivery with ${populated ? 'populated' : 'absent optional'} values`, () => {
      const literal = '\n"\' $USER_MESSAGE $CONTEXT $INPUTS.plan $& $$ $(echo inert); `echo inert`';
      const value = (prefix: string): string => (populated ? `${prefix}${literal}` : '');
      const values: UserControlledVariableContext = populated
        ? {
            userMessage: `message${literal}`,
            loopUserInput: `feedback${literal}`,
            rejectionReason: `rejection${literal}`,
            loopPrevOutput: `previous${literal}`,
            issueContext: `issue${literal}`,
          }
        : { userMessage: '' };
      const env = buildExecNodeEnvironment({
        artifactsDir: '/artifacts',
        stateDir: '/state',
        logDir: '/logs',
        workflowId: 'run-1',
        baseBranch: 'dev',
        ...values,
        loopUserInput: values.loopUserInput ?? '',
        rejectionReason: values.rejectionReason ?? '',
        loopPrevOutput: values.loopPrevOutput ?? '',
        typedArtifactsFile: '/listing.json',
        nodeExecution: null,
        inputEnvKeys: [],
      });
      const names = USER_CONTROLLED_VARIABLES.flatMap(group => group.names);
      const template = names.map(name => `$${name}`).join(' | ');
      const substitute = (shellSafe: boolean) =>
        substituteWorkflowVariables(
          template,
          'run-1',
          values.userMessage,
          '/artifacts',
          'dev',
          'docs/',
          values.issueContext,
          values.loopUserInput,
          values.rejectionReason,
          values.loopPrevOutput,
          { shellSafe }
        );

      for (const group of USER_CONTROLLED_VARIABLES) {
        for (const name of group.names) {
          expect(env[name]).toBe(values[group.source] ?? '');
          expect(EXEC_NODE_ENVIRONMENT_NAMES.has(name)).toBe(true);
        }
      }
      expect(substitute(false)).toEqual({
        prompt: names.map(name => env[name]).join(' | '),
        contextSubstituted: populated,
      });
      expect(substitute(true)).toEqual({ prompt: template, contextSubstituted: populated });
      expect(env).toEqual({
        ARTIFACTS_DIR: '/artifacts',
        STATE_DIR: '/state',
        LOG_DIR: '/logs',
        ADOPTED_RUN_DIR: '',
        WORKFLOW_ID: 'run-1',
        BASE_BRANCH: 'dev',
        USER_MESSAGE: value('message'),
        ARGUMENTS: value('message'),
        LOOP_USER_INPUT: value('feedback'),
        REJECTION_REASON: value('rejection'),
        LOOP_PREV_OUTPUT: value('previous'),
        CONTEXT: value('issue'),
        EXTERNAL_CONTEXT: value('issue'),
        ISSUE_CONTEXT: value('issue'),
        TYPED_ARTIFACTS_FILE: '/listing.json',
        ARCHON_NODE_EXECUTION: '',
        ARCHON_RUN_ENV_KEYS: JSON.stringify([...EXEC_NODE_ENVIRONMENT_NAMES]),
      });
    });
  }
});

describe('substituteWorkflowVariables', () => {
  it('retains prefix matching for ordinary user variables', () => {
    const { prompt } = substituteWorkflowVariables(
      '$USER_MESSAGE_SUFFIX $ARGUMENTS_SUFFIX $LOOP_USER_INPUT_SUFFIX $REJECTION_REASON_SUFFIX $LOOP_PREV_OUTPUT_SUFFIX',
      'run-1',
      'message',
      '/tmp',
      'main',
      'docs/',
      undefined,
      'feedback',
      'rejection',
      'previous'
    );
    expect(prompt).toBe(
      'message_SUFFIX message_SUFFIX feedback_SUFFIX rejection_SUFFIX previous_SUFFIX'
    );
  });

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

  it('inserts every value verbatim, never reading it as a variable or a replacement pattern', () => {
    const { prompt, contextSubstituted } = substituteWorkflowVariables(
      '$ARGUMENTS | $INPUTS.plan | $CONTEXT',
      'run-1',
      "msg $& $' $INPUTS.plan $CONTEXT",
      '/tmp',
      'main',
      'docs/',
      'issue $ARGUMENTS',
      undefined,
      undefined,
      undefined,
      { inputs: { plan: 'plan $ARGUMENTS $$' } }
    );
    expect(prompt).toBe("msg $& $' $INPUTS.plan $CONTEXT | plan $ARGUMENTS $$ | issue $ARGUMENTS");
    expect(contextSubstituted).toBe(true);
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
