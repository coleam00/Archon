import { describe, test, expect } from 'bun:test';
import {
  isExecNode,
  isGateNode,
  isWaitNode,
  isHaltNode,
  isLoopNode,
  isLoopGroupNode,
  isIncludeDirective,
  isTriggerRule,
  TRIGGER_RULES,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  GATE_AND_HALT_IGNORED_FIELDS,
  KNOWN_DAG_NODE_KEYS,
  WAIT_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  BASH_NODE_AI_FIELDS,
  approvalOnRejectSchema,
  dagNodeFlatSchema,
  dagNodeSchema,
  execNodeSchema,
  MAX_DURABLE_WAIT_MS,
  waitConfigSchema,
  inputEnvKey,
  readSubrunMetadata,
  RUN_METADATA_KEYS,
  readIdentityUnresolved,
  workflowWaitContextSchema,
  scheduledWorkflowResumeSchema,
  workflowWaitStepName,
  runAttention,
  nodeOutputSchema,
} from './schemas';
import type { RunAttentionInput, SuspendReason, WorkflowRunStatus } from './schemas';
import type {
  DagNode,
  AgentNode,
  ExecNode,
  HaltNode,
  IncludeDirective,
  ComposeFanOutNode,
  TriggerRule,
  WaitConfig,
} from './schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const commandNode: AgentNode = {
  id: 'n1',
  kind: 'agent',
  source: { kind: 'command', name: 'build' },
};
const promptNode: AgentNode = {
  id: 'n2',
  kind: 'agent',
  source: { kind: 'inline', prompt: 'Do this inline.' },
};
const bashNode: ExecNode = { id: 'n3', kind: 'exec', runtime: 'sh', script: 'echo hello' };
const cancelNode: HaltNode = { id: 'n5', kind: 'halt', reason: 'Precondition failed' };

describe('nodeOutputSchema', () => {
  test('requires provenance on skipped outputs while pending remains cause-free', () => {
    expect(nodeOutputSchema.safeParse({ state: 'skipped', output: '' }).success).toBe(false);
    expect(nodeOutputSchema.safeParse({ state: 'pending', output: '' }).success).toBe(true);

    for (const cause of [
      { kind: 'condition', expr: '$route.output == true' },
      { kind: 'condition_parse_error', expr: '$route.output =' },
      { kind: 'upstream_failed', origin: 'validate' },
      { kind: 'upstream_skipped', origin: 'optional-review' },
    ]) {
      expect(nodeOutputSchema.safeParse({ state: 'skipped', output: '', cause }).success).toBe(
        true
      );
    }
  });
});

describe('persisted workflow continuation schemas', () => {
  const timeWait = {
    owner: 'node' as const,
    nodeId: 'later',
    kind: 'time' as const,
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2026-08-25T10:00:00.000Z',
  };

  test('requires the fields belonging to the persisted wait kind and owner', () => {
    expect(workflowWaitContextSchema.safeParse(timeWait).success).toBe(true);
    expect(
      workflowWaitContextSchema.safeParse({ ...timeWait, event: 'deploy.complete' }).success
    ).toBe(false);
    expect(workflowWaitContextSchema.safeParse({ ...timeWait, kind: 'event' }).success).toBe(false);

    const loopEvent = workflowWaitContextSchema.parse({
      owner: 'loop_group',
      nodeId: 'release',
      bodyWaitId: 'checks',
      iteration: 2,
      sessionId: null,
      sessionProvider: null,
      kind: 'event',
      event: 'checks.complete',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2026-08-25T10:00:00.000Z',
    });
    expect(workflowWaitStepName(loopEvent)).toBe('release.checks');

    const attention = workflowWaitContextSchema.parse({
      owner: 'node',
      nodeId: 'recover-ci',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Rerun CI, then resume.',
    });
    expect(workflowWaitStepName(attention)).toBe('recover-ci');
    expect(
      workflowWaitContextSchema.safeParse({ ...attention, resumeAt: timeWait.resumeAt }).success
    ).toBe(false);

    const loopAttention = workflowWaitContextSchema.parse({
      owner: 'loop_group',
      nodeId: 'recover',
      bodyWaitId: 'operator',
      iteration: 2,
      sessionId: null,
      sessionProvider: null,
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Fix the external failure, then resume.',
    });
    expect(workflowWaitStepName(loopAttention)).toBe('recover.operator');
  });

  test('rejects quota continuations beyond their attempt or time budget', () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-25T10:00:00.000Z',
      deadlineAt: '2026-08-26T10:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
    };
    expect(scheduledWorkflowResumeSchema.safeParse(scheduled).success).toBe(true);
    expect(scheduledWorkflowResumeSchema.safeParse({ ...scheduled, attempt: 3 }).success).toBe(
      false
    );
    expect(
      scheduledWorkflowResumeSchema.safeParse({
        ...scheduled,
        resumeAt: '2026-08-27T10:00:00.000Z',
      }).success
    ).toBe(false);
  });
});

describe('dagNodeSchema — durable wait', () => {
  test('normalizes duration, until, bounded event, and attention waits', () => {
    const duration = dagNodeSchema.parse({ id: 'later', wait: { duration_ms: 5000 } });
    const until = dagNodeSchema.parse({
      id: 'clock',
      wait: { until: '2026-08-25T10:00:00Z' },
    });
    const event = dagNodeSchema.parse({
      id: 'ci',
      wait: { event: 'checks.complete', deadline_ms: 60_000 },
    });
    const attention = dagNodeSchema.parse({
      id: 'recover',
      wait: { attention: '  Rerun CI, then resume.  ' },
    });
    expect(isWaitNode(duration as DagNode)).toBe(true);
    expect((until as DagNode).kind).toBe('wait');
    expect((event as DagNode).kind).toBe('wait');
    expect((event as DagNode).output_format?.required).toEqual(['status', 'waited_ms']);
    expect((attention as DagNode).kind).toBe('wait');
    expect((attention as DagNode & { wait: { attention: string } }).wait.attention).toBe(
      'Rerun CI, then resume.'
    );
  });

  test('rejects ambiguous and unbounded waits', () => {
    const mixedWait = { duration_ms: 1, until: '2026-08-25T10:00:00Z' };
    // @ts-expect-error A programmatic caller must not be able to construct two wait variants.
    const invalidTypedWait: WaitConfig = mixedWait;
    expect(waitConfigSchema.safeParse(invalidTypedWait).success).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'mixed', wait: { duration_ms: 1, until: 'later' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'event', wait: { event: 'checks.complete' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'blank-event', wait: { event: '   ', deadline_ms: 1 } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'blank-attention', wait: { attention: '   ' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({
        id: 'mixed-attention',
        wait: { attention: 'Resume me', duration_ms: 1 },
      }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'duration', wait: { duration_ms: 1, deadline_ms: 2 } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({
        id: 'custom-output',
        wait: { duration_ms: 1 },
        output_format: { type: 'string' },
      }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'repeating', wait: { duration_ms: 1 }, always_run: true })
        .success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'invalid-date', wait: { until: 'tomorrow' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'stray-dollar', wait: { until: 'tomorrow$' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'dynamic-date', wait: { until: '$schedule.output' } }).success
    ).toBe(true);
    expect(
      dagNodeSchema.safeParse({ id: 'input-date', wait: { until: '$INPUTS.resume_at' } }).success
    ).toBe(true);
    expect(
      dagNodeSchema.safeParse({ id: 'date-only', wait: { until: '2026-08-25' } }).success
    ).toBe(false);
  });

  test('bounds persisted delays before they can overflow their timestamps', () => {
    expect(waitConfigSchema.safeParse({ duration_ms: MAX_DURABLE_WAIT_MS }).success).toBe(true);
    expect(waitConfigSchema.safeParse({ duration_ms: MAX_DURABLE_WAIT_MS + 1 }).success).toBe(
      false
    );
    expect(
      waitConfigSchema.safeParse({
        event: 'checks.complete',
        deadline_ms: MAX_DURABLE_WAIT_MS,
      }).success
    ).toBe(true);
    expect(
      waitConfigSchema.safeParse({
        event: 'checks.complete',
        deadline_ms: MAX_DURABLE_WAIT_MS + 1,
      }).success
    ).toBe(false);
  });
});

describe('dagNodeSchema — context', () => {
  test('parses scalar and named resume contexts on AI consumers', () => {
    expect(
      (dagNodeSchema.parse({ id: 'fresh', prompt: 'work', context: 'fresh' }) as DagNode).context
    ).toBe('fresh');
    expect(
      (dagNodeSchema.parse({ id: 'shared', command: 'work', context: 'shared' }) as DagNode).context
    ).toBe('shared');
    expect(
      (
        dagNodeSchema.parse({
          id: 'named',
          prompt: 'work',
          context: { resume: 'source' },
        }) as DagNode
      ).context
    ).toEqual({ resume: 'source' });
  });

  test('rejects named resume on a deterministic node instead of stripping it', () => {
    const result = dagNodeSchema.safeParse({
      id: 'shell',
      bash: 'echo work',
      context: { resume: 'source' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        "'context.resume' is only supported on command and prompt nodes"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// isExecNode (formerly isBashNode + isScriptNode — bash/script collapsed into
// one 'exec' kind, distinguished by `runtime`, #2486)
// ---------------------------------------------------------------------------

describe('isExecNode', () => {
  test('returns true for a sh-runtime (formerly bash) node', () => {
    expect(isExecNode(bashNode)).toBe(true);
  });

  test('returns true for a sh-runtime node with timeout', () => {
    const withTimeout: ExecNode = {
      id: 'b',
      kind: 'exec',
      runtime: 'sh',
      script: 'npm test',
      timeout: 60000,
    };
    expect(isExecNode(withTimeout)).toBe(true);
  });

  test('returns true for a sh-runtime node with depends_on', () => {
    const withDeps: ExecNode = {
      id: 'b',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo done',
      depends_on: ['n1'],
    };
    expect(isExecNode(withDeps)).toBe(true);
  });

  test('returns true for a bun-runtime (formerly script) node', () => {
    const scriptNode: ExecNode = {
      id: 's1',
      kind: 'exec',
      runtime: 'bun',
      script: 'console.log("hi")',
    };
    expect(isExecNode(scriptNode)).toBe(true);
  });

  test('returns true for a script node with deps', () => {
    const withDeps: ExecNode = {
      id: 's',
      kind: 'exec',
      runtime: 'bun',
      script: 'import zod from "zod"',
      deps: ['zod'],
    };
    expect(isExecNode(withDeps)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isExecNode(commandNode)).toBe(false);
  });

  test('returns false for an AgentNode', () => {
    expect(isExecNode(promptNode)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCancelNode
// ---------------------------------------------------------------------------

describe('isHaltNode', () => {
  test('returns true for a HaltNode', () => {
    expect(isHaltNode(cancelNode)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isHaltNode(commandNode)).toBe(false);
  });

  test('returns false for an AgentNode', () => {
    expect(isHaltNode(promptNode)).toBe(false);
  });

  test('returns false for an ExecNode', () => {
    expect(isHaltNode(bashNode)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTriggerRule
// ---------------------------------------------------------------------------

describe('isTriggerRule', () => {
  test('returns true for all canonical trigger rules', () => {
    const rules: string[] = [...TRIGGER_RULES];
    for (const rule of rules) {
      expect(isTriggerRule(rule)).toBe(true);
    }
  });

  test('returns true for "all_success"', () => {
    expect(isTriggerRule('all_success')).toBe(true);
  });

  test('returns true for "one_success"', () => {
    expect(isTriggerRule('one_success')).toBe(true);
  });

  test('returns true for "none_failed_min_one_success"', () => {
    expect(isTriggerRule('none_failed_min_one_success')).toBe(true);
  });

  test('returns true for "all_done"', () => {
    expect(isTriggerRule('all_done')).toBe(true);
  });

  test('returns false for an unknown string', () => {
    expect(isTriggerRule('any_success')).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isTriggerRule('')).toBe(false);
  });

  test('returns false for a number', () => {
    expect(isTriggerRule(1)).toBe(false);
  });

  test('returns false for null', () => {
    expect(isTriggerRule(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isTriggerRule(undefined)).toBe(false);
  });

  test('returns false for an object', () => {
    expect(isTriggerRule({})).toBe(false);
  });

  test('is used as a TriggerRule type after guard (compile-time verification)', () => {
    const value: unknown = 'all_success';
    if (isTriggerRule(value)) {
      // TypeScript should narrow value to TriggerRule here
      const rule: TriggerRule = value;
      expect(rule).toBe('all_success');
    } else {
      // Should not reach here
      expect(true).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TRIGGER_RULES constant
// ---------------------------------------------------------------------------

describe('TRIGGER_RULES', () => {
  test('contains exactly four entries', () => {
    expect(TRIGGER_RULES).toHaveLength(4);
  });

  test('all entries are strings', () => {
    for (const rule of TRIGGER_RULES) {
      expect(typeof rule).toBe('string');
    }
  });

  test('is readonly (does not expose mutation methods at runtime)', () => {
    // The readonly modifier is enforced at compile time; at runtime it's a plain array.
    // Verify the values are stable and match expectations.
    expect(TRIGGER_RULES).toContain('all_success');
    expect(TRIGGER_RULES).toContain('one_success');
    expect(TRIGGER_RULES).toContain('none_failed_min_one_success');
    expect(TRIGGER_RULES).toContain('all_done');
  });
});

// ---------------------------------------------------------------------------
// approvalOnRejectSchema
// ---------------------------------------------------------------------------

describe('approvalOnRejectSchema', () => {
  test('accepts valid on_reject config', () => {
    const result = approvalOnRejectSchema.safeParse({
      prompt: 'Fix: $REJECTION_REASON',
      max_attempts: 3,
    });
    expect(result.success).toBe(true);
  });

  test('accepts on_reject without max_attempts (uses default)', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: 'Please revise' });
    expect(result.success).toBe(true);
  });

  test('rejects empty prompt', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('on_reject.prompt');
  });

  test('rejects max_attempts: 0', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: 'Fix it', max_attempts: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects max_attempts: 11', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: 'Fix it', max_attempts: 11 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// approval.decisions — new authoring surface (#2707 step 1)
// ---------------------------------------------------------------------------

describe('approval.decisions — new authoring surface (#2707)', () => {
  test('parses a valid explicit decisions array, marking decisionsAuthored', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: {
        message: 'ok?',
        decisions: [{ id: 'approve', label: 'Ship it' }, { id: 'reject' }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success && !isIncludeDirective(result.data) && isGateNode(result.data)) {
      expect(result.data.decisionsAuthored).toBe(true);
      expect(result.data.decisions).toEqual([
        { id: 'approve', label: 'Ship it' },
        { id: 'reject' },
      ]);
    }
  });

  test('omitted decisions synthesizes the default pair with decisionsAuthored: false', () => {
    const result = dagNodeSchema.safeParse({ id: 'gate', approval: { message: 'ok?' } });
    expect(result.success).toBe(true);
    if (result.success && !isIncludeDirective(result.data) && isGateNode(result.data)) {
      expect(result.data.decisionsAuthored).toBe(false);
      expect(result.data.decisions).toEqual([{ id: 'approve' }, { id: 'reject' }]);
    }
  });

  test('rejects an id outside {approve, reject}', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: { message: 'ok?', decisions: [{ id: 'escalate' }] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects duplicate ids', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: { message: 'ok?', decisions: [{ id: 'approve' }, { id: 'approve' }] },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unique');
  });

  test('rejects decisions with no approve entry (R3 fix)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: { message: 'ok?', decisions: [{ id: 'reject' }] },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('approve');
  });

  test('accepts an approve-only decisions array (acknowledge gate, reject optional)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: { message: 'ok?', decisions: [{ id: 'approve' }] },
    });
    expect(result.success).toBe(true);
  });

  test('rejects decisions combined with on_reject — mutually exclusive', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: {
        message: 'ok?',
        decisions: [{ id: 'approve' }, { id: 'reject' }],
        on_reject: { prompt: 'fix it' },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('mutually exclusive');
  });

  test('rejects an empty decisions array', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: { message: 'ok?', decisions: [] },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dagNodeSchema — empty bash/prompt validation
// ---------------------------------------------------------------------------

describe('dagNodeSchema — empty bash/prompt', () => {
  test('emits "bash script cannot be empty" for bash: ""', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', bash: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('bash script cannot be empty');
    }
  });

  test('emits "bash script cannot be empty" for whitespace-only bash', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', bash: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('bash script cannot be empty');
    }
  });

  test('emits "prompt cannot be empty" for prompt: ""', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', prompt: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('prompt cannot be empty');
    }
  });

  test('emits "prompt cannot be empty" for whitespace-only prompt', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', prompt: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('prompt cannot be empty');
    }
  });

  test('passes for bash: "echo hello"', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', bash: 'echo hello' });
    expect(result.success).toBe(true);
  });

  test('still emits generic error when no mode field is present', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('must have either');
    }
  });
});

// ---------------------------------------------------------------------------
// dagNodeSchema — Claude SDK options
// ---------------------------------------------------------------------------

describe('dagNodeSchema — new Claude SDK options', () => {
  test('parses the strongest effort rung on a prompt node', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', effort: 'ultra' });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as AgentNode).effort).toBe('ultra');
  });

  test('rejects invalid effort value', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', effort: 'extreme' });
    expect(result.success).toBe(false);
  });

  test('rejects retired thinking config and names effort', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', thinking: 'adaptive' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['thinking']);
      expect(result.error.issues[0]?.message).toContain('effort:');
    }
  });

  test('parses maxBudgetUsd as positive number', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', maxBudgetUsd: 2.5 });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as AgentNode).maxBudgetUsd).toBe(2.5);
  });

  test('rejects negative maxBudgetUsd', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', maxBudgetUsd: -1 });
    expect(result.success).toBe(false);
  });

  test('rejects zero maxBudgetUsd', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', maxBudgetUsd: 0 });
    expect(result.success).toBe(false);
  });

  test('parses betas array', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      betas: ['context-1m-2025-08-07'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as AgentNode).betas).toEqual(['context-1m-2025-08-07']);
  });

  test('rejects empty betas array', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', betas: [] });
    expect(result.success).toBe(false);
  });

  test('parses sandbox object', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      sandbox: { enabled: true, filesystem: { allowWrite: ['src/'] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as AgentNode).sandbox?.enabled).toBe(true);
    }
  });

  test('parses systemPrompt string', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      systemPrompt: 'You are a security reviewer',
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect((result.data as AgentNode).systemPrompt).toBe('You are a security reviewer');
  });

  test('rejects empty systemPrompt string', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', systemPrompt: '' });
    expect(result.success).toBe(false);
  });

  test('parses fallbackModel string', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      fallbackModel: 'claude-haiku-4-5-20251001',
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect((result.data as AgentNode).fallbackModel).toBe('claude-haiku-4-5-20251001');
  });

  test('parses settingSources array of valid sources', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      settingSources: ['project'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as AgentNode).settingSources).toEqual(['project']);
  });

  test('rejects settingSources with invalid source value', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      settingSources: ['project', 'global'],
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-array settingSources', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      settingSources: 'project',
    });
    expect(result.success).toBe(false);
  });

  test('strips settingSources from bash nodes', () => {
    const result = dagNodeSchema.safeParse({
      id: 'b',
      bash: 'echo hi',
      settingSources: ['project'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect('settingSources' in result.data).toBe(false);
  });

  test('strips AI-only fields from bash nodes', () => {
    const result = dagNodeSchema.safeParse({
      id: 'b',
      bash: 'echo hi',
      effort: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // bash nodes don't get AI-only fields in the transform
      expect('effort' in result.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// dagNodeSchema — per-node Pi extension posture (`pi:`, #2133)
// ---------------------------------------------------------------------------

describe('dagNodeSchema — per-node Pi posture (pi:)', () => {
  test('accepts and preserves a pi: block on a prompt node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      prompt: 'plan it',
      pi: { interactive: true, extensionFlags: { plan: true, 'plan-file': 'PLAN.md' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as AgentNode).pi).toEqual({
        interactive: true,
        extensionFlags: { plan: true, 'plan-file': 'PLAN.md' },
      });
    }
  });

  test('preserves a pi: block on a loop node (the plannotator leak seam, #2073)', () => {
    // Loops drop model/provider in the transform, but pi MUST survive — the loop
    // is exactly where the implement node needs its posture scoped down.
    const result = dagNodeSchema.safeParse({
      id: 'implement',
      loop: { prompt: 'do work', until: 'DONE', max_iterations: 5 },
      pi: { interactive: false, extensionFlags: { plan: false } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isLoopNode(result.data as DagNode)).toBe(true);
      expect((result.data as DagNode & { pi?: unknown }).pi).toEqual({
        interactive: false,
        extensionFlags: { plan: false },
      });
    }
  });

  test('drops pi: from a bash node in the transform', () => {
    const result = dagNodeSchema.safeParse({
      id: 'sh',
      bash: 'echo hi',
      pi: { interactive: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('pi' in result.data).toBe(false);
    }
  });

  test('rejects a non-boolean/string extensionFlags value', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      prompt: 'plan it',
      pi: { extensionFlags: { plan: 42 } },
    });
    expect(result.success).toBe(false);
  });

  test('pi is warned-ignored on non-AI + loop_group nodes but supported on loop', () => {
    // loop uses its per-iteration sendQuery, so pi must NOT be in its ignore list;
    // loop_group never sendQuerys (body nodes carry their own pi), so it warns.
    expect(LOOP_NODE_AI_FIELDS).not.toContain('pi');
    expect(LOOP_GROUP_NODE_AI_FIELDS).toContain('pi');
    expect(SCRIPT_NODE_AI_FIELDS).toContain('pi');
  });
});

// ---------------------------------------------------------------------------
// dagNodeSchema — ExecNode parsing and validation
// ---------------------------------------------------------------------------

describe('dagNodeSchema — ExecNode', () => {
  test('derives authored exec fields from the resolved ExecNode owner', () => {
    expect(dagNodeFlatSchema.shape.deps.unwrap()).toBe(execNodeSchema.shape.deps);
    expect(KNOWN_DAG_NODE_KEYS).toEqual(new Set(Object.keys(dagNodeFlatSchema.shape)));

    const authoredRuntime = dagNodeFlatSchema.shape.runtime.unwrap();
    expect(authoredRuntime.options).toEqual(
      execNodeSchema.shape.runtime.options.filter(runtime => runtime !== 'sh')
    );

    const raw = { id: 's', script: '   ', runtime: 'bun' };
    const flat = dagNodeFlatSchema.safeParse(raw);
    const authored = dagNodeSchema.safeParse(raw);
    const resolved = execNodeSchema.safeParse({
      id: 's',
      kind: 'exec',
      script: '   ',
      runtime: 'bun',
    });
    expect(flat.success).toBe(true);
    expect(authored.success).toBe(false);
    expect(resolved.success).toBe(false);
    if (!authored.success && !resolved.success) {
      expect(authored.error.issues[0]?.message).toBe(resolved.error.issues[0]?.message);
    }
  });

  test('parses a bun script node with inline script', () => {
    const result = dagNodeSchema.safeParse({
      id: 'fetch',
      script: 'console.log("hello")',
      runtime: 'bun',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isExecNode(result.data as DagNode)).toBe(true);
      const node = result.data as ExecNode;
      expect(node.script).toBe('console.log("hello")');
      expect(node.runtime).toBe('bun');
    }
  });

  test('parses a uv script node with inline script', () => {
    const result = dagNodeSchema.safeParse({
      id: 'py',
      script: 'print("hello")',
      runtime: 'uv',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isExecNode(result.data as DagNode)).toBe(true);
      const node = result.data as ExecNode;
      expect(node.runtime).toBe('uv');
    }
  });

  test('parses a script node with deps', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'import httpx',
      runtime: 'uv',
      deps: ['httpx', 'beautifulsoup4'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as ExecNode;
      expect(node.deps).toEqual(['httpx', 'beautifulsoup4']);
    }
  });

  test('parses a script node with timeout', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      timeout: 30000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as ExecNode;
      expect(node.timeout).toBe(30000);
    }
  });

  test('parses a script node with depends_on', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      depends_on: ['prev'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as ExecNode;
      expect(node.depends_on).toEqual(['prev']);
    }
  });

  test('rejects script node without runtime', () => {
    const result = dagNodeSchema.safeParse({ id: 's', script: 'console.log("hi")' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('runtime');
    }
  });

  test('rejects invalid runtime value', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'node',
    });
    expect(result.success).toBe(false);
  });

  test("keeps the internal 'sh' runtime behind the authored bash projection", () => {
    const authoredScript = dagNodeSchema.safeParse({
      id: 's',
      script: 'echo hi',
      runtime: 'sh',
    });
    expect(authoredScript.success).toBe(false);

    const authoredBash = dagNodeSchema.safeParse({ id: 's', bash: 'echo hi' });
    expect(authoredBash.success).toBe(true);
    if (authoredBash.success) {
      expect(authoredBash.data).toMatchObject({
        kind: 'exec',
        script: 'echo hi',
        runtime: 'sh',
      });
    }
  });

  test('ignores deferred exec fields on every mode that does not select them', () => {
    const cases: readonly {
      name: string;
      node: Record<string, unknown>;
      ignored: Record<string, unknown>;
    }[] = [
      {
        name: 'command',
        node: { id: 'command', command: 'review' },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'prompt',
        node: { id: 'prompt', prompt: 'Review this.' },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'loop',
        node: {
          id: 'loop',
          loop: { prompt: 'Review this.', until: 'DONE', max_iterations: 1 },
        },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'loop_group',
        node: {
          id: 'loop-group',
          loop_group: {
            until: 'DONE',
            max_iterations: 1,
            nodes: [{ id: 'review', prompt: 'Review this.' }],
          },
        },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'approval',
        node: { id: 'approval', approval: { message: 'Continue?' } },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'wait',
        node: { id: 'wait', wait: { duration_ms: 1 } },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'cancel',
        node: { id: 'cancel', cancel: 'Stop.' },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'include',
        node: { id: 'include', include: 'child' },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'workflow',
        node: { id: 'workflow', workflow: 'child' },
        ignored: { bash: '   ', script: '   ', timeout: 0 },
      },
      {
        name: 'bash',
        node: { id: 'bash', bash: 'echo hi' },
        ignored: { script: '   ' },
      },
      {
        name: 'script',
        node: { id: 'script', script: 'console.log("hi")', runtime: 'bun' },
        ignored: { bash: '   ' },
      },
    ];

    for (const { name, node, ignored } of cases) {
      const baseline = dagNodeSchema.safeParse(node);
      const withIgnoredFields = dagNodeSchema.safeParse({ ...node, ...ignored });
      expect(baseline.success, `${name} baseline`).toBe(true);
      expect(withIgnoredFields.success, name).toBe(true);
      if (baseline.success && withIgnoredFields.success) {
        expect(withIgnoredFields.data, name).toEqual(baseline.data);
      }
    }
  });

  test('ignores unsupported with values on every mode that drops with', () => {
    const cases: readonly { name: string; node: Record<string, unknown> }[] = [
      { name: 'bash', node: { id: 'bash', bash: 'echo hi' } },
      { name: 'prompt', node: { id: 'prompt', prompt: 'Review this.' } },
      {
        name: 'loop',
        node: {
          id: 'loop',
          loop: { prompt: 'Review this.', until: 'DONE', max_iterations: 1 },
        },
      },
      {
        name: 'loop_group',
        node: {
          id: 'loop-group',
          loop_group: {
            until: 'DONE',
            max_iterations: 1,
            nodes: [{ id: 'review', prompt: 'Review this.' }],
          },
        },
      },
      { name: 'approval', node: { id: 'approval', approval: { message: 'Continue?' } } },
      { name: 'wait', node: { id: 'wait', wait: { duration_ms: 1 } } },
      { name: 'cancel', node: { id: 'cancel', cancel: 'Stop.' } },
    ];

    for (const { name, node } of cases) {
      const baseline = dagNodeSchema.safeParse(node);
      const withIgnoredValue = dagNodeSchema.safeParse({ ...node, with: ['ignored'] });
      expect(baseline.success, `${name} baseline`).toBe(true);
      expect(withIgnoredValue.success, name).toBe(true);
      if (baseline.success && withIgnoredValue.success) {
        expect(withIgnoredValue.data, name).toEqual(baseline.data);
      }
    }
  });

  test('validates with against the exec owner after script mode is selected', () => {
    const result = dagNodeSchema.safeParse({
      id: 'script',
      script: 'console.log("hi")',
      runtime: 'bun',
      with: ['not-a-map'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "'with' on script nodes must be an object mapping input names to values"
      );
    }
  });

  // The command and script paths must reject the same authored input names. They
  // reached one validator before the owner-derived split; a script path that skips
  // validateWithShape silently widens the accepted key grammar for scripts only.
  test('rejects an invalid input name on script with, exactly as command does', () => {
    const script = dagNodeSchema.safeParse({
      id: 'script',
      script: 'console.log("hi")',
      runtime: 'bun',
      with: { '1bad': 'value' },
    });
    const command = dagNodeSchema.safeParse({
      id: 'command',
      command: 'thing',
      with: { '1bad': 'value' },
    });
    expect(script.success).toBe(false);
    expect(command.success).toBe(false);
    if (!script.success && !command.success) {
      const nameIssue = (issues: readonly { message: string }[]) =>
        issues.find(i => /invalid (script|command) input name/.test(i.message))?.message;
      expect(nameIssue(script.error.issues)).toBe(
        "invalid script input name '1bad'; use letters, numbers, underscores, or hyphens and start with a letter or underscore"
      );
      expect(nameIssue(command.error.issues)).toBe(
        "invalid command input name '1bad'; use letters, numbers, underscores, or hyphens and start with a letter or underscore"
      );
    }
  });

  test('rejects empty script string', () => {
    const result = dagNodeSchema.safeParse({ id: 's', script: '', runtime: 'bun' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('script cannot be empty');
    }
  });

  test('rejects whitespace-only script', () => {
    const result = dagNodeSchema.safeParse({ id: 's', script: '   ', runtime: 'bun' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('script cannot be empty');
    }
  });

  test('rejects negative timeout on script node', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      timeout: -1,
    });
    expect(result.success).toBe(false);
  });

  test('rejects script + bash (mutually exclusive)', () => {
    // Deliberately authored with BOTH old flat fields — this exercises the
    // pre-transform (authored) schema's mutual-exclusivity check, unrelated to
    // the resolved discriminated-union shape (#2486).
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      bash: 'echo hi',
      runtime: 'bun',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('rejects script + prompt (mutually exclusive)', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      prompt: 'Do something',
      runtime: 'bun',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('rejects script + command (mutually exclusive)', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      command: 'some-command',
      runtime: 'bun',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('strips AI-only fields from script nodes', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      effort: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('effort' in result.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SCRIPT_NODE_AI_FIELDS constant
// ---------------------------------------------------------------------------

describe('SCRIPT_NODE_AI_FIELDS', () => {
  test('contains provider and model fields', () => {
    expect(SCRIPT_NODE_AI_FIELDS).toContain('provider');
    expect(SCRIPT_NODE_AI_FIELDS).toContain('model');
  });

  test('contains all AI-specific fields', () => {
    const expectedFields = [
      'provider',
      'model',
      'context',
      'allowed_tools',
      'denied_tools',
      'hooks',
      'mcp',
      'skills',
      'effort',
      'maxBudgetUsd',
      'systemPrompt',
      'fallbackModel',
      'betas',
      'sandbox',
    ];
    for (const field of expectedFields) {
      expect(SCRIPT_NODE_AI_FIELDS).toContain(field);
    }
  });

  // #2453: the one AI field an exec node now OWNS. It is enforced against the node's
  // stdout, so warning that it is ignored would be a lie — and it must stay listed on
  // every node kind derived from this list that still has no execution site for it.
  test('excludes output_format, which exec nodes now enforce (#2453)', () => {
    expect(BASH_NODE_AI_FIELDS).not.toContain('output_format');
    expect(SCRIPT_NODE_AI_FIELDS).not.toContain('output_format');
    for (const list of [
      GATE_AND_HALT_IGNORED_FIELDS,
      INCLUDE_NODE_IGNORED_FIELDS,
      WAIT_NODE_IGNORED_FIELDS,
    ]) {
      for (const field of BASH_NODE_AI_FIELDS) expect(list).toContain(field);
    }
    // Re-added where the field stays meaningless…
    expect(GATE_AND_HALT_IGNORED_FIELDS).toContain('output_format');
    expect(LOOP_GROUP_NODE_AI_FIELDS).toContain('output_format');
    expect(INCLUDE_NODE_IGNORED_FIELDS).toContain('output_format');
    // …but NOT on a wait, whose schema rejects the field outright rather than warning.
    expect(WAIT_NODE_IGNORED_FIELDS).not.toContain('output_format');
    expect(
      dagNodeSchema.safeParse({
        id: 'w',
        wait: { duration_ms: 5000 },
        output_format: { type: 'object' },
      }).success
    ).toBe(false);
  });

  test('an exec node KEEPS output_format through the transform (#2453)', () => {
    const outputFormat = { type: 'object', properties: { ready: { type: 'boolean' } } };
    for (const body of [
      { bash: 'echo hi' },
      { script: 'console.log("hi")', runtime: 'bun' },
    ] as const) {
      const result = dagNodeSchema.safeParse({ id: 'n', ...body, output_format: outputFormat });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable: asserted above');
      expect((result.data as { output_format?: unknown }).output_format).toEqual(outputFormat);
    }
  });
});

// ---------------------------------------------------------------------------
// LOOP_NODE_AI_FIELDS constant
// ---------------------------------------------------------------------------

describe('LOOP_NODE_AI_FIELDS', () => {
  test('excludes model and provider (loop nodes support them)', () => {
    expect(LOOP_NODE_AI_FIELDS).not.toContain('model');
    expect(LOOP_NODE_AI_FIELDS).not.toContain('provider');
  });

  test('contains all other AI-specific fields from BASH_NODE_AI_FIELDS', () => {
    // `output_format` is deliberately absent since #2563 — a loop: node makes its
    // own sendQuery, so the schema is honoured rather than warned-and-dropped.
    const expectedFields = [
      'context',
      'allowed_tools',
      'denied_tools',
      'hooks',
      'mcp',
      'skills',
      'effort',
      'maxBudgetUsd',
      'systemPrompt',
      'fallbackModel',
      'betas',
      'sandbox',
    ];
    for (const field of expectedFields) {
      expect(LOOP_NODE_AI_FIELDS).toContain(field);
    }
  });
});

describe('dagNodeSchema — loop_group', () => {
  test('parses a valid loop_group node with a recursive body', () => {
    const result = dagNodeSchema.safeParse({
      id: 'grp',
      loop_group: {
        until: 'DONE',
        max_iterations: 5,
        fresh_context: false,
        nodes: [
          { id: 'a', prompt: 'do a', depends_on: [] },
          { id: 'b', bash: 'echo hi', depends_on: ['a'] },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isLoopGroupNode(result.data as DagNode)).toBe(true);
      const grp = result.data as { loop_group?: { nodes: unknown[] } };
      expect(grp.loop_group?.nodes).toHaveLength(2);
    }
  });

  test('loop_group + prompt are mutually exclusive', () => {
    const result = dagNodeSchema.safeParse({
      id: 'grp',
      prompt: 'inline',
      loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
      expect(result.error.issues[0].message).toContain('loop_group');
    }
  });

  test('loop_group + loop are mutually exclusive', () => {
    const result = dagNodeSchema.safeParse({
      id: 'grp',
      loop: { prompt: 'p', until: 'DONE', max_iterations: 3 },
      loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('loop_group rejects retry (loop manages its own iteration)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'grp',
      retry: { max_attempts: 2, delay_ms: 1000 },
      loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const retryIssue = result.error.issues.find(i => i.message.includes('retry'));
      expect(retryIssue).toBeDefined();
      expect(retryIssue?.message).toContain('loop_group');
    }
  });

  test('loop_group requires at least one body node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'grp',
      loop_group: { until: 'DONE', max_iterations: 3, nodes: [] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('at least one node'))).toBe(true);
    }
  });

  test('loop_group rejects a body with no completion channel', () => {
    const result = dagNodeSchema.safeParse({
      id: 'grp',
      loop_group: { max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('completion channel'))).toBe(true);
    }
  });

  test('loop_group accepts until_bash alone (no prose signal) — #2563', () => {
    const result = dagNodeSchema.safeParse({
      id: 'grp',
      loop_group: {
        max_iterations: 3,
        until_bash: 'test -f ./done',
        nodes: [{ id: 'x', bash: 'echo hi' }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const grp = result.data as { loop_group?: { until?: string; until_bash?: string } };
      expect(grp.loop_group?.until).toBeUndefined();
      expect(grp.loop_group?.until_bash).toBe('test -f ./done');
    }
  });

  test('nested loop_group body parses (loop_group inside loop_group)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'outer',
      loop_group: {
        until: 'OUTER_DONE',
        max_iterations: 3,
        nodes: [
          {
            id: 'inner',
            loop_group: {
              until: 'INNER_DONE',
              max_iterations: 2,
              nodes: [{ id: 'inner-work', prompt: 'work', depends_on: [] }],
            },
            depends_on: [],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const outer = result.data as {
        loop_group?: { nodes: Array<{ loop_group?: { nodes: unknown[] } }> };
      };
      const inner = outer.loop_group?.nodes[0];
      expect(isLoopGroupNode(inner as never)).toBe(true);
      expect(inner?.loop_group?.nodes).toHaveLength(1);
    }
  });
});

describe('dagNodeSchema — loop completion channel (#2563)', () => {
  test('a loop declaring only until_bash parses, with no prose signal', () => {
    const result = dagNodeSchema.safeParse({
      id: 'deterministic',
      loop: {
        prompt: 'fix the failing tests',
        max_iterations: 5,
        until_bash: 'bun run test',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { loop?: { until?: string; until_bash?: string } };
      expect(node.loop?.until).toBeUndefined();
      expect(node.loop?.until_bash).toBe('bun run test');
    }
  });

  test('a loop declaring only until still parses (unchanged)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'prose',
      loop: { prompt: 'iterate', until: 'COMPLETE', max_iterations: 5 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { loop?: { until?: string } };
      expect(node.loop?.until).toBe('COMPLETE');
    }
  });

  test('a loop with no channel is rejected, naming every channel it could declare', () => {
    const result = dagNodeSchema.safeParse({
      id: 'no-channel',
      loop: { prompt: 'iterate', max_iterations: 5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(i => i.message.includes('completion channel'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('loop.until');
      expect(issue?.message).toContain('loop.until_bash');
      // A `loop:` has three channels, so the message must offer all three — an
      // author told about two would not learn the one this PR added exists.
      expect(issue?.message).toContain('loop.until_field');
      expect(issue?.path).toEqual(['loop', 'until']);
    }
  });

  test('an empty-string until is rejected rather than treated as absent', () => {
    const result = dagNodeSchema.safeParse({
      id: 'blank',
      loop: { prompt: 'iterate', until: '', max_iterations: 5 },
    });
    expect(result.success).toBe(false);
  });

  // Channel-verdict matrix — this package's half. The cross-package guard that
  // actually ENFORCES agreement is `scripts/node-ref-parity.test.ts`, which runs both
  // encodings over one corpus and compares verdicts in CI; this matrix stays as the
  // engine's own regression coverage. `structural.test.ts` in @archon/web mirrors
  // these case names. Change one, change both — the guard will say so if you don't.
  describe('channel verdict matrix (twin: builder structural.test.ts)', () => {
    const cases: Array<[string, Record<string, string>, boolean]> = [
      ['neither declared', {}, false],
      ['until only, real', { until: 'COMPLETE' }, true],
      ['until_bash only, real', { until_bash: 'bun run test' }, true],
      ['both real', { until: 'COMPLETE', until_bash: 'bun run test' }, true],
      ['until blank, no bash', { until: '  ' }, false],
      ['until blank + real bash', { until: ' ', until_bash: 'bun run test' }, false],
      ['real until + blank bash', { until: 'COMPLETE', until_bash: '   ' }, false],
      ['both blank', { until: ' ', until_bash: '\t' }, false],
      ['until empty string', { until: '' }, false],
      ['until_bash empty string', { until_bash: '' }, false],
      ['padded until (legit)', { until: ' COMPLETE ' }, true],
      ['multiline until_bash (legit)', { until_bash: '  set -e\n  test -f x\n' }, true],
      // Third channel (#2563 Part B) — same case names as the builder's twin.
      ['until_field only, real', { until_field: 'done' }, true],
      ['until_field blank', { until_field: '  ' }, false],
    ];

    // `until_field` cases need an `output_format` on the node or they would be
    // rejected for a DIFFERENT reason ("declares no 'output_format'") — which would
    // make the matrix agree with the builder by accident rather than on the channel
    // rule it exists to compare. The builder mirrors only the channel rules, so the
    // schema is supplied here to isolate the same question.
    const untilFieldSchema = {
      type: 'object',
      properties: { done: { type: 'boolean' } },
      required: ['done'],
    };

    for (const [name, channels, shouldParse] of cases) {
      test(`${name} -> ${shouldParse ? 'accepted' : 'rejected'}`, () => {
        const needsSchema = 'until_field' in channels;
        const result = dagNodeSchema.safeParse({
          id: 'l',
          ...(needsSchema ? { output_format: untilFieldSchema } : {}),
          loop: { prompt: 'iterate', max_iterations: 5, ...channels },
        });
        expect(result.success).toBe(shouldParse);
      });
    }
  });

  test('a blank channel is rejected even when its sibling is valid', () => {
    // The aggregate at-least-one rule only fires when BOTH are blank, so the
    // per-field checks are what catch these two. Both are broken at runtime, not
    // merely untidy: `bash -c "   "` exits 0 (completing on iteration 1), and a blank
    // signal reaches detectCompletionSignal, whose own-line pattern matches any
    // whitespace-only line the model emits.
    const blankSignal = dagNodeSchema.safeParse({
      id: 'a',
      loop: { prompt: 'p', until: ' ', until_bash: 'bun run test', max_iterations: 5 },
    });
    expect(blankSignal.success).toBe(false);
    if (!blankSignal.success) {
      expect(blankSignal.error.issues.some(i => i.message.includes("'loop.until' must be"))).toBe(
        true
      );
    }

    const blankCheck = dagNodeSchema.safeParse({
      id: 'b',
      loop: { prompt: 'p', until: 'COMPLETE', until_bash: '   ', max_iterations: 5 },
    });
    expect(blankCheck.success).toBe(false);
    if (!blankCheck.success) {
      expect(
        blankCheck.error.issues.some(i => i.message.includes("'loop.until_bash' must be"))
      ).toBe(true);
    }
  });

  test('a declared channel is validated but never rewritten', () => {
    // Trimming for validation is not trimming for storage: `until` is matched
    // verbatim by detectCompletionSignal and `until_bash` is executed verbatim, so
    // rewriting either here would silently change what an existing workflow does.
    const result = dagNodeSchema.safeParse({
      id: 'verbatim',
      loop: {
        prompt: 'p',
        until: ' COMPLETE ',
        until_bash: '  set -e\n  test -f x\n',
        max_iterations: 5,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { loop?: { until?: string; until_bash?: string } };
      expect(node.loop?.until).toBe(' COMPLETE ');
      expect(node.loop?.until_bash).toBe('  set -e\n  test -f x\n');
    }
  });
});

describe('dagNodeSchema — loop.until_field (#2563)', () => {
  const schema = {
    type: 'object',
    properties: { done: { type: 'boolean' }, note: { type: 'string' } },
    required: ['done'],
  };
  const loopWith = (loop: Record<string, unknown>, output_format?: unknown) =>
    dagNodeSchema.safeParse({
      id: 'l',
      ...(output_format !== undefined ? { output_format } : {}),
      loop: { prompt: 'p', max_iterations: 5, ...loop },
    });

  test('a valid until_field parses and keeps output_format on the node', () => {
    const result = loopWith({ until_field: 'done' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { output_format?: unknown; loop?: { until_field?: string } };
      // Before #2563 the transform dropped output_format for loop nodes entirely.
      expect(node.output_format).toEqual(schema);
      expect(node.loop?.until_field).toBe('done');
    }
  });

  test('until_field alone satisfies the completion-channel rule', () => {
    // No `until`, no `until_bash` — the structured channel is a channel.
    expect(loopWith({ until_field: 'done' }, schema).success).toBe(true);
  });

  test('until_field without output_format is rejected', () => {
    const result = loopWith({ until_field: 'done' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes("declares no 'output_format'"))).toBe(
        true
      );
    }
  });

  test('until_field naming an undeclared property is rejected, listing what is declared', () => {
    const result = loopWith({ until_field: 'finished' }, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(i => i.message.includes('not declared'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('done, note');
    }
  });

  test('until_field must be listed in output_format.required', () => {
    // Otherwise a schema-valid payload may omit it, "absent" reads as "not
    // complete", and the loop burns max_iterations reporting the wrong cause.
    const optional = {
      type: 'object',
      properties: { done: { type: 'boolean' } },
    };
    const result = loopWith({ until_field: 'done' }, optional);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('output_format.required'))).toBe(
        true
      );
    }
  });

  test('until_field declared as a non-boolean type is rejected', () => {
    const stringy = {
      type: 'object',
      properties: { done: { type: 'string' } },
      required: ['done'],
    };
    const result = loopWith({ until_field: 'done' }, stringy);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes("must be 'boolean'"))).toBe(true);
    }
  });

  test('a property with no declared type is accepted', () => {
    // JSON Schema does not require `type`; only a WRONG type is a violation.
    const untyped = { type: 'object', properties: { done: {} }, required: ['done'] };
    expect(loopWith({ until_field: 'done' }, untyped).success).toBe(true);
  });

  test('output_format without until_field is fine (structured output, prose termination)', () => {
    expect(loopWith({ until: 'DONE' }, schema).success).toBe(true);
  });

  test('until_field on a loop_group is an unknown key, leaving it channel-less', () => {
    // Declined by design: a loop_group body node can declare output_format and be
    // read by `until_bash: '[ "$decide.output.done" = "true" ]'`, so the existing
    // wiring already expresses it there. The key is stripped and the group is left
    // with no channel at all, which is the error the author sees.
    const result = dagNodeSchema.safeParse({
      id: 'g',
      loop_group: { max_iterations: 3, until_field: 'done', nodes: [{ id: 'x', bash: 'echo' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(i => i.message.includes('completion channel'));
      expect(issue).toBeDefined();
      // The group's message names only the two channels a group has.
      expect(issue?.message).not.toContain('until_field');
    }
  });
});

describe('LOOP_GROUP_NODE_AI_FIELDS', () => {
  test('excludes model/provider (forwarded to body AI nodes)', () => {
    expect(LOOP_GROUP_NODE_AI_FIELDS).not.toContain('model');
    expect(LOOP_GROUP_NODE_AI_FIELDS).not.toContain('provider');
  });

  test('differs from LOOP_NODE_AI_FIELDS on pi (#2133) and output_format (#2563)', () => {
    // Both differences have the same cause: a plain loop: node calls sendQuery
    // itself, so its per-node Pi posture AND its output_format schema both reach
    // that call. A loop_group never calls sendQuery — its body nodes carry their
    // own — so both stay warned-ignored on the group.
    expect(LOOP_NODE_AI_FIELDS).not.toContain('pi');
    expect(LOOP_NODE_AI_FIELDS).not.toContain('output_format');
    expect(LOOP_GROUP_NODE_AI_FIELDS).toContain('pi');
    expect(LOOP_GROUP_NODE_AI_FIELDS).toContain('output_format');
    expect(LOOP_GROUP_NODE_AI_FIELDS.filter(f => f !== 'pi' && f !== 'output_format')).toEqual([
      ...LOOP_NODE_AI_FIELDS,
    ]);
  });
});

// ---------------------------------------------------------------------------
// output_format survival through the transform (#2566)
// ---------------------------------------------------------------------------

describe('dagNodeSchema — output_format survival by node type', () => {
  /**
   * The lists above are the loader's WARN sets; this is what the transform actually
   * emits, which is a different fact and the one the `when:` whole-output rejection
   * (#2566) reasons from. `output_format` is in the schema's `aiOnly` group, which the
   * `loop_group` branch spreads and the `loop` branch does not.
   *
   * Pinned here because the loader's three rejection messages, the authoring guide and
   * the constitution's case-law row all ASSERT this asymmetry in prose. Those assertions
   * are unverifiable by the type checker (they are string literals) and the loader tests
   * pin only the message wording, not the claim inside it — so before this test the fact
   * was stated in five places and derived from none. Its history earned it: the claim was
   * written three times across #2579 and was wrong or imprecise twice.
   *
   * #2563 is the change this tripwire was written to catch, and it fired: a `loop:`
   * node now KEEPS `output_format` (it makes its own sendQuery, so the schema reaches
   * the provider and the node's output becomes the validated JSON). The loader message
   * telling authors that declaring one on a loop "would change nothing" was removed
   * with it — a `loop:` is now classified `schema-capable` and gets the same remedy as
   * a prompt node. The asymmetry that remains is `loop_group:`, which never calls the
   * provider itself.
   */
  const outputFormat = { type: 'object', properties: { done: { type: 'boolean' } } };

  function parsedNode(extra: Record<string, unknown>) {
    const result = dagNodeSchema.safeParse({ id: 'n1', ...extra, output_format: outputFormat });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable: asserted above');
    return result.data as { output_format?: unknown };
  }

  test('a loop node KEEPS output_format (#2563 — it runs its own sendQuery)', () => {
    expect(
      parsedNode({ loop: { until: 'DONE', max_iterations: 3, prompt: 'go' } }).output_format
    ).toEqual(outputFormat);
  });

  test('a loop_group node KEEPS output_format (aiOnly is spread)', () => {
    const node = parsedNode({
      loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'body', prompt: 'x' }] },
    });
    expect(node.output_format).toEqual(outputFormat);
  });

  test('prompt and command nodes KEEP output_format', () => {
    expect(parsedNode({ prompt: 'go' }).output_format).toEqual(outputFormat);
    expect(parsedNode({ command: 'some-command' }).output_format).toEqual(outputFormat);
  });
});

describe('dagNodeSchema — include', () => {
  test('parses a valid include node (only structural fields survive)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      include: 'archon-review-block',
      depends_on: ['finalize-pr'],
      when: 'always',
      trigger_rule: 'all_success',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isIncludeDirective(result.data)).toBe(true);
      const node = result.data as IncludeDirective;
      expect(node.kind).toBe('include');
      expect(node.include).toBe('archon-review-block');
      expect(node.depends_on).toEqual(['finalize-pr']);
      expect(node.when).toBe('always');
      expect(node.trigger_rule).toBe('all_success');
    }
  });

  test('trims surrounding whitespace on the target name', () => {
    const result = dagNodeSchema.safeParse({ id: 'r', include: '  archon-review-block  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as IncludeDirective).include).toBe('archon-review-block');
    }
  });

  test('include + command are mutually exclusive', () => {
    const result = dagNodeSchema.safeParse({
      id: 'r',
      command: 'build',
      include: 'archon-review-block',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
      expect(result.error.issues[0].message).toContain('include');
    }
  });

  test('empty include is rejected', () => {
    const result = dagNodeSchema.safeParse({ id: 'r', include: '' });
    expect(result.success).toBe(false);
  });

  test("include accepts and retains a string-valued 'with:' mapping", () => {
    const result = dagNodeSchema.safeParse({
      id: 'r',
      include: 'archon-review-block',
      with: { pr: '$create.output', base_branch: 'main', empty: '' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as IncludeDirective).with).toEqual({
        pr: '$create.output',
        base_branch: 'main',
        empty: '',
      });
    }
  });

  test.each([
    ['null', null],
    ['an array', ['main']],
    ['a non-JSON value', { branch: new Date() }],
    ['an invalid key', { 'bad.key': 'main' }],
  ])("include rejects 'with:' when it is %s", (_description, withValue) => {
    const result = dagNodeSchema.safeParse({
      id: 'r',
      include: 'archon-review-block',
      with: withValue,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path[0] === 'with')).toBe(true);
    }
  });

  // #2637: with values widened from string-only to JSON values — a boolean/number/
  // array/object literal loads and keeps its logical type through the transform.
  test("include accepts and retains typed JSON 'with:' values", () => {
    const result = dagNodeSchema.safeParse({
      id: 'r',
      include: 'archon-review-block',
      with: { flag: true, count: 3, tags: ['a', 'b'], meta: { k: 'v' }, nothing: null },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as IncludeDirective).with).toEqual({
        flag: true,
        count: 3,
        tags: ['a', 'b'],
        meta: { k: 'v' },
        nothing: null,
      });
    }
  });

  test("rejects the reserved node id 'INPUTS'", () => {
    const result = dagNodeSchema.safeParse({ id: 'INPUTS', prompt: 'work' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const idIssue = result.error.issues.find(issue => issue.path[0] === 'id');
      expect(idIssue?.message).toContain('$INPUTS.<name>');
    }
  });

  test('include node drops AI/exec fields (they are ignored)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'r',
      include: 'archon-review-block',
      model: 'opus',
      always_run: true,
      output_type: 'code',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as Record<string, unknown>;
      expect(node.model).toBeUndefined();
      expect(node.always_run).toBeUndefined();
      expect(node.output_type).toBeUndefined();
    }
  });
});

describe('dagNodeSchema — launch-only options on an include node (#1764)', () => {
  test.each([
    ['isolation', { isolation: 'worktree' }],
    ['input', { input: 'do the thing' }],
  ])('rejects %s, naming the option and pointing at workflow:', (field, extra) => {
    const result = dagNodeSchema.safeParse({ id: 'review', include: 'blk', ...extra });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map(i => i.message).join(' | ');
      expect(message).toContain(`'${field}' is not supported on an include node`);
      expect(message).toContain("'workflow:' node");
    }
  });

  // #2512: `fan_out:` on an include node is now the composed fan-out surface — it parses
  // to a deferred ComposeFanOutNode instead of being rejected as launch-only.
  test('include + fan_out parses to a deferred compose_fan_out node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      include: 'archon-review-block',
      depends_on: ['gather'],
      fan_out: { items: '$list.output', as: 'item', max_parallel: 3 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as ComposeFanOutNode;
      expect(node.kind).toBe('compose_fan_out');
      expect(node.include).toBe('archon-review-block');
      expect(node.fan_out.max_parallel).toBe(3);
      expect(node.fan_out.join).toBe('all_done');
      expect(isIncludeDirective(result.data)).toBe(false);
    }
  });

  test('compose fan-out requires an explicit item binding', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      include: 'blk',
      fan_out: { items: '$list.output' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message).join(' | ')).toContain('fan_out.as');
    }
  });

  test('compose fan-out rejects join: first_success', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      include: 'blk',
      fan_out: { items: '$list.output', join: 'first_success' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map(i => i.message).join(' | ');
      expect(message).toContain('first_success');
    }
  });

  test('compose fan-out rejects fan_out.as colliding with a with: key', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      include: 'blk',
      with: { item: 'static' },
      fan_out: { items: '$list.output', as: 'item' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map(i => i.message).join(' | ');
      expect(message).toContain('collides with');
    }
  });

  test('a merely-meaningless AI field on an include node still only warns', () => {
    // The distinction the rejection above rests on: `model:` says nothing composition
    // has to refuse, it is simply unread. INCLUDE_NODE_IGNORED_FIELDS keeps warning.
    const result = dagNodeSchema.safeParse({ id: 'review', include: 'blk', model: 'opus' });
    expect(result.success).toBe(true);
  });
});

describe('INCLUDE_NODE_IGNORED_FIELDS', () => {
  test('is a superset of BASH_NODE_AI_FIELDS plus exec-only fields', () => {
    for (const f of BASH_NODE_AI_FIELDS) {
      expect(INCLUDE_NODE_IGNORED_FIELDS).toContain(f);
    }
    for (const f of ['retry', 'output_type', 'always_run', 'idle_timeout', 'timeout']) {
      expect(INCLUDE_NODE_IGNORED_FIELDS).toContain(f);
    }
    // Structural fields the include node legitimately carries are NOT ignored.
    for (const f of ['id', 'depends_on', 'when', 'trigger_rule', 'include', 'description']) {
      expect(INCLUDE_NODE_IGNORED_FIELDS).not.toContain(f);
    }
  });
});

describe('dagNodeSchema — mutates_checkout tree-integrity declaration (#2771)', () => {
  test('parses a boolean on an exec node and carries it through the transform', () => {
    const result = dagNodeSchema.safeParse({
      id: 'guard',
      bash: 'echo hi',
      mutates_checkout: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('mutates_checkout' in result.data && result.data.mutates_checkout === false).toBe(
        true
      );
    }
  });

  test('parses true and stays absent when undeclared', () => {
    const declared = dagNodeSchema.safeParse({ id: 'a', prompt: 'x', mutates_checkout: true });
    expect(
      declared.success &&
        'mutates_checkout' in declared.data &&
        declared.data.mutates_checkout === true
    ).toBe(true);
    const absent = dagNodeSchema.safeParse({ id: 'b', prompt: 'x' });
    expect(absent.success && !('mutates_checkout' in absent.data)).toBe(true);
  });

  test('rejects a non-boolean value', () => {
    const result = dagNodeSchema.safeParse({ id: 'a', bash: 'echo hi', mutates_checkout: 'no' });
    expect(result.success).toBe(false);
  });

  test('is warned as ignored on wait nodes, not silently stripped', () => {
    // The field parses into the base shape (so Zod does not drop it), but a wait's
    // lifecycle is engine-owned — the loader warns via WAIT_NODE_IGNORED_FIELDS.
    for (const f of ['mutates_checkout']) {
      expect(WAIT_NODE_IGNORED_FIELDS).toContain(f);
      expect(WORKFLOW_NODE_IGNORED_FIELDS).toContain(f);
      expect(BASH_NODE_AI_FIELDS).not.toContain(f); // enforced on exec/agent nodes
    }
  });
});

describe('inputEnvKey (#2470)', () => {
  test('mangles an input name to INPUTS_<UPPER_SNAKE>', () => {
    expect(inputEnvKey('plan')).toBe('INPUTS_PLAN');
    expect(inputEnvKey('base-branch')).toBe('INPUTS_BASE_BRANCH');
    expect(inputEnvKey('foo_bar')).toBe('INPUTS_FOO_BAR');
    // hyphen and underscore fold to the same key — the loader rejects such a pair.
    expect(inputEnvKey('foo-bar')).toBe(inputEnvKey('foo_bar'));
  });
});

describe('readSubrunMetadata — inputs (#2470)', () => {
  test('reads a well-formed inputs map', () => {
    const md = readSubrunMetadata({ inputs: { plan: 'do it', mode: 'fast' } });
    expect(md.inputs).toEqual({ plan: 'do it', mode: 'fast' });
  });

  test('treats a non-string-valued or non-object inputs as unset', () => {
    expect(readSubrunMetadata({ inputs: { plan: 5 } }).inputs).toBeUndefined();
    expect(readSubrunMetadata({ inputs: ['a'] }).inputs).toBeUndefined();
    expect(readSubrunMetadata({}).inputs).toBeUndefined();
    expect(readSubrunMetadata(undefined).inputs).toBeUndefined();
  });
});

// #2304: a row-level marker that distinguishes "unregistered project" from "identity
// could not be resolved". The reader is defensive the same way `readSubrunMetadata`
// is: a non-boolean value (corrupt, hand edit, future format) reads as `undefined`
// rather than as `false`, so a row never silently downgrades to a 'resolved' posture.
describe('readIdentityUnresolved (#2304)', () => {
  test('reads a true stamp', () => {
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: true })).toBe(true);
  });

  test('reads a false stamp', () => {
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: false })).toBe(false);
  });

  test('treats a missing key as undefined', () => {
    expect(readIdentityUnresolved({})).toBeUndefined();
    expect(readIdentityUnresolved(undefined)).toBeUndefined();
  });

  test('treats a non-boolean value as undefined (defensive)', () => {
    expect(
      readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: 'yes' })
    ).toBeUndefined();
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: 1 })).toBeUndefined();
    expect(
      readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: null })
    ).toBeUndefined();
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: {} })).toBeUndefined();
  });
});

describe('runAttention', () => {
  const pausedOn = (approval: unknown, overrides: Partial<RunAttentionInput> = {}) =>
    ({
      id: 'run-1',
      status: 'paused',
      metadata: { approval },
      completed_at: null,
      ...overrides,
    }) satisfies RunAttentionInput;

  const gate = (over: Record<string, unknown> = {}) => ({
    nodeId: 'review',
    message: 'Approve the plan.',
    ...over,
  });

  describe('still progressing under its own power', () => {
    test.each(['pending', 'running'] as const)('returns null for a %s run', status => {
      expect(runAttention({ id: 'run-1', status, metadata: {} })).toBeNull();
    });

    test('returns null for a resolved gate awaiting auto-resume', () => {
      expect(runAttention(pausedOn(gate({ resolved: 'approved' })))).toBeNull();
      expect(runAttention(pausedOn(gate({ resolved: 'rejected' })))).toBeNull();
    });

    test('returns null for a `wait:` pause — the clock owns it, not a person', () => {
      const run = {
        id: 'run-1',
        status: 'paused' as const,
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'hold',
            kind: 'time',
            waitingSince: '2026-08-28T10:00:00.000Z',
            resumeAt: '2026-08-28T11:00:00.000Z',
          },
        },
      };
      expect(runAttention(run)).toBeNull();
    });

    test('reports an attention wait as an explicit resume action', () => {
      const run = {
        id: 'run-1',
        status: 'paused' as const,
        metadata: {
          wait: {
            owner: 'loop_group' as const,
            nodeId: 'recover-ci',
            bodyWaitId: 'operator-action',
            iteration: 1,
            sessionId: null,
            sessionProvider: null,
            kind: 'attention' as const,
            waitingSince: '2026-08-28T10:00:00.000Z',
            message: 'Rerun the failing check, then resume.',
          },
        },
      };
      expect(runAttention(run)).toEqual({
        kind: 'action_required',
        runId: 'run-1',
        nodeId: 'recover-ci.operator-action',
        message: 'Rerun the failing check, then resume.',
      });
    });

    test('a resolved child_workflow gate is still nobody’s decision', () => {
      // Order matters: resolution is checked before the child redirect, so a gate
      // already resolved never re-addresses a human at the child.
      expect(
        runAttention(
          pausedOn(gate({ type: 'child_workflow', childRunId: 'kid', resolved: 'approved' }))
        )
      ).toBeNull();
    });
  });

  describe('terminal', () => {
    test.each(['completed', 'failed', 'cancelled'] as const)('reports %s with its time', status => {
      const at = new Date('2026-08-28T12:00:00.000Z');
      expect(runAttention({ id: 'run-1', status, metadata: {}, completed_at: at })).toEqual({
        kind: 'terminal',
        runId: 'run-1',
        status,
        at,
      });
    });

    test('carries a null time when the row has none', () => {
      const attention = runAttention({ id: 'run-1', status: 'failed', metadata: {} });
      expect(attention).toEqual({ kind: 'terminal', runId: 'run-1', status: 'failed', at: null });
    });

    test('a terminal status wins over leftover gate metadata', () => {
      const attention = runAttention({
        id: 'run-1',
        status: 'cancelled',
        metadata: { approval: gate() },
      });
      expect(attention?.kind).toBe('terminal');
    });
  });

  describe('awaiting a human', () => {
    // Every recognized reason EXCEPT child_workflow, plus the legacy undefined.
    const humanReasons: (SuspendReason | undefined)[] = [
      'approval',
      'interactive_loop',
      'writeback',
      undefined,
    ];

    test.each(humanReasons)('addresses the decision at this run for type %s', type => {
      const approval = type === undefined ? gate() : gate({ type });
      expect(runAttention(pausedOn(approval))).toEqual({
        kind: 'awaiting_response',
        runId: 'run-1',
        respondTo: { runId: 'run-1', nodeId: 'review' },
        message: 'Approve the plan.',
      });
    });
  });

  describe('blocked on a child', () => {
    test('reports the block and never claims a human is needed', () => {
      // The parent row cannot tell "child on a gate" from "child still running",
      // so asserting awaiting_response here would wake a host for normal progress.
      const attention = runAttention(
        pausedOn(gate({ type: 'child_workflow', nodeId: 'sub', childRunId: 'kid' }))
      );
      expect(attention).toEqual({
        kind: 'blocked_on_child',
        runId: 'run-1',
        childRunId: 'kid',
        nodeId: 'sub',
      });
    });

    test('a block pointer with nothing to follow is unreadable, not a redirect', () => {
      for (const childRunId of [undefined, '']) {
        const attention = runAttention(
          pausedOn(gate({ type: 'child_workflow', nodeId: 'sub', childRunId }))
        );
        expect(attention).toMatchObject({ kind: 'unreadable', reason: 'child_pointer_missing' });
      }
    });
  });

  describe('unreadable', () => {
    test.each([undefined, null, {}, { nodeId: 'x' }, 'garbage', 42])(
      'malformed gate metadata (%p) still needs a human',
      approval => {
        const attention = runAttention(pausedOn(approval));
        expect(attention).toMatchObject({
          kind: 'unreadable',
          runId: 'run-1',
          reason: 'malformed_gate',
        });
      }
    );

    test('an empty node id is no address at all', () => {
      expect(runAttention(pausedOn(gate({ nodeId: '' })))).toMatchObject({
        kind: 'unreadable',
        reason: 'malformed_gate',
      });
    });

    test('a gate type this build cannot resolve is unreadable', () => {
      const attention = runAttention(pausedOn(gate({ type: 'from_the_future' })));
      expect(attention).toMatchObject({
        kind: 'unreadable',
        reason: 'unrecognized_gate_type',
      });
      expect((attention as { detail: string }).detail).toContain('from_the_future');
    });

    test('a malformed gate is read before its type, so reject keeps tolerating it', () => {
      // assertRejectable tolerates unreadable gate metadata but must refuse an
      // unrecognized type. Ordering these the other way would flip that.
      expect(runAttention(pausedOn({ type: 'from_the_future' }))).toMatchObject({
        reason: 'malformed_gate',
      });
    });
  });

  test('a gate wins over a stale wait key, and neither is ever both', () => {
    // The write helpers strip each other's key (writeApprovalMetadata /
    // replaceWaitMetadata), so this pins the exclusivity rather than trusting it.
    const attention = runAttention({
      id: 'run-1',
      status: 'paused',
      metadata: {
        approval: gate(),
        wait: {
          owner: 'node',
          nodeId: 'hold',
          kind: 'time',
          waitingSince: '2026-08-28T10:00:00.000Z',
          resumeAt: '2026-08-28T11:00:00.000Z',
        },
      },
    });
    expect(attention?.kind).toBe('awaiting_response');
  });

  test('an attention wait wins over stale approval metadata', () => {
    const attention = runAttention({
      id: 'run-1',
      status: 'paused',
      metadata: {
        approval: gate(),
        wait: {
          owner: 'node',
          nodeId: 'recover',
          kind: 'attention',
          waitingSince: '2026-08-28T10:00:00.000Z',
          message: 'Recover the external dependency.',
        },
      },
    });
    expect(attention?.kind).toBe('action_required');
  });

  test('an absent metadata bag on a paused run is unreadable, not silence', () => {
    const attention = runAttention({ id: 'run-1', status: 'paused' as WorkflowRunStatus });
    expect(attention).toMatchObject({ kind: 'unreadable', reason: 'malformed_gate' });
  });
});
