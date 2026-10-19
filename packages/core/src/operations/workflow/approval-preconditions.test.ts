// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  assertAnswerable,
  assertApprovable,
  assertRejectable,
  ChildRunRedirectError,
} from './test-harness';

describe('assertApprovable / assertRejectable — shared precondition gate', () => {
  const baseRun = {
    origin: { conversationId: 'conv-1' },
    id: 'run-1',
    status: 'paused',
    workflow_name: 'assist',
    working_path: '/tmp/x',
    conversation_id: 'conv-1',
    user_message: 'hi',
    metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
  } as unknown as WorkflowRun;

  const withMeta = (metadata: Record<string, unknown>, status = 'paused') =>
    ({ ...baseRun, status, metadata }) as unknown as WorkflowRun;

  test('assertApprovable returns the approval context on a well-formed paused run', () => {
    expect(assertApprovable(baseRun).nodeId).toBe('gate');
  });

  test('assertApprovable rejects a non-paused run', () => {
    expect(() => assertApprovable(withMeta(baseRun.metadata, 'running'))).toThrow(
      "Cannot approve run with status 'running'"
    );
  });

  test('assertApprovable rejects a missing approval context', () => {
    expect(() => assertApprovable(withMeta({}))).toThrow(
      'Workflow run is paused but missing approval context.'
    );
  });

  test('assertApprovable redirects a child_workflow-blocked parent to the child run', () => {
    expect(() =>
      assertApprovable(
        withMeta({
          approval: {
            nodeId: 'sub',
            message: 'blocked',
            type: 'child_workflow',
            childRunId: 'child-9',
          },
        })
      )
    ).toThrow('Approve or reject the child run instead.');
  });

  test('assertApprovable rejects an already-resolved gate', () => {
    expect(() =>
      assertApprovable(withMeta({ approval: { nodeId: 'g', message: 'm', resolved: 'approved' } }))
    ).toThrow('was already approved and is awaiting resume');
  });

  test('assertRejectable TOLERATES a missing approval context (unlike approve)', () => {
    expect(assertRejectable(withMeta({}))).toBeUndefined();
  });

  test('assertRejectable redirects a child_workflow-blocked parent', () => {
    expect(() =>
      assertRejectable(
        withMeta({
          approval: {
            nodeId: 'sub',
            message: 'blocked',
            type: 'child_workflow',
            childRunId: 'child-9',
          },
        })
      )
    ).toThrow('Reject the child run instead, or abandon this run to discard the whole tree.');
  });

  test('assertRejectable rejects an already-resolved gate', () => {
    expect(() =>
      assertRejectable(withMeta({ approval: { nodeId: 'g', message: 'm', resolved: 'rejected' } }))
    ).toThrow('was already rejected and is awaiting resume');
  });

  // Both functions now read ONE derivation (`runAttention`). These pin the exact
  // messages that derivation has to keep producing at this entry point.
  const childGate = (over: Record<string, unknown> = {}) => ({
    approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', ...over },
  });

  test('the child redirect names the child run verbatim, for both verbs', () => {
    expect(() => assertApprovable(withMeta(childGate({ childRunId: 'child-9' })))).toThrow(
      "Run run-1 is paused waiting on sub-run child-9 ('workflow:' node 'sub'). " +
        'Approve or reject the child run instead.'
    );
    expect(() => assertRejectable(withMeta(childGate({ childRunId: 'child-9' })))).toThrow(
      "Run run-1 is paused waiting on sub-run child-9 ('workflow:' node 'sub'). " +
        'Reject the child run instead, or abandon this run to discard the whole tree.'
    );
  });

  // The redirect names a command, and every surface spells it differently, so the
  // error carries the decision as data and never bakes one spelling into `message`.
  test('the child redirect is typed, command-free, and spells per surface', () => {
    const slack = { formatWorkflowCommand: (c: string) => `/archon-workflow ${c}` };
    const thrown = (verb: 'approve' | 'reject'): InstanceType<typeof ChildRunRedirectError> => {
      try {
        if (verb === 'approve') assertApprovable(withMeta(childGate({ childRunId: 'child-9' })));
        else assertRejectable(withMeta(childGate({ childRunId: 'child-9' })));
      } catch (error) {
        if (error instanceof ChildRunRedirectError) return error;
        throw error;
      }
      throw new Error(`assert${verb} did not refuse a blocked parent`);
    };

    for (const verb of ['approve', 'reject'] as const) {
      const error = thrown(verb);
      expect({
        parentRunId: error.parentRunId,
        childRunIds: error.childRunIds,
        nodeId: error.nodeId,
        action: error.action,
      }).toEqual({
        parentRunId: 'run-1',
        childRunIds: ['child-9'],
        nodeId: 'sub',
        action: verb,
      });
      expect(error.message).toContain('child-9');
      expect(error.message).not.toContain('/workflow ');
      expect(error.message).not.toContain('archon workflow ');

      const onSlack = error.messageFor(slack);
      expect(onSlack).toContain(`/archon-workflow ${verb} child-9`);
      expect(onSlack.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
      expect(onSlack).not.toContain('archon workflow ');
      // A surface with no spelling of its own still goes through the one mechanism.
      expect(error.messageFor({})).toContain(`/workflow ${verb} child-9`);
    }
  });

  test('a fan-out parent redirects approve, reject and answer to every child it waits on', () => {
    const fanOut = withMeta({
      approval: {
        nodeId: 'work',
        message: 'waiting',
        type: 'fan_out',
        childRunIds: ['kid-0', 'kid-2'],
        unspawnedItems: 0,
      },
    });
    for (const assertFn of [assertApprovable, assertRejectable, assertAnswerable]) {
      let error: unknown;
      try {
        assertFn(fanOut);
      } catch (thrown) {
        error = thrown;
      }
      if (!(error instanceof ChildRunRedirectError)) throw new Error('expected a redirect');
      expect(error.childRunIds).toEqual(['kid-0', 'kid-2']);
      expect(error.message).toContain("waiting on sub-runs kid-0, kid-2 ('fan_out' node 'work')");
      const spelled = error.messageFor({});
      expect(spelled).toContain(`/workflow ${error.action} kid-0`);
      expect(spelled).toContain(`/workflow ${error.action} kid-2`);
    }
  });

  test('a block pointer with no child id says so instead of naming <unknown>', () => {
    // The old message interpolated '<unknown>' into a command the operator could
    // not run. A corrupt pointer is now its own state with its own explanation.
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(childGate()))).toThrow(
        'Run run-1 cannot be resolved: blocked on a sub-run at node ' +
          "'sub' but the child run id is missing."
      );
      expect(() => assertFn(withMeta(childGate()))).not.toThrow('<unknown>');
    }
  });

  test('an unrecognized gate type is refused by both verbs', () => {
    const unknownType = { approval: { nodeId: 'g', message: 'm', type: 'from_the_future' } };
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(unknownType))).toThrow(
        "Run run-1 has an unrecognized gate type 'from_the_future'. " +
          'This Archon build cannot resolve it.'
      );
    }
  });

  test('a `wait:` pause is not approvable and is silently rejectable', () => {
    // A durable wait resumes itself; there is no gate to approve, but rejecting a
    // parked run to cancel it stays legitimate (it never had an approval context).
    const waiting = {
      wait: {
        owner: 'node',
        nodeId: 'hold',
        kind: 'time',
        waitingSince: '2026-08-28T10:00:00.000Z',
        resumeAt: '2026-08-28T11:00:00.000Z',
      },
    };
    expect(() => assertApprovable(withMeta(waiting))).toThrow(
      'Workflow run is paused but missing approval context.'
    );
    expect(assertRejectable(withMeta(waiting))).toBeUndefined();
  });

  test('a usage-limit wait is refused by both verbs', () => {
    // Rejecting it would cancel the run under an approval audit trail for a gate
    // that never existed; cancel and abandon are the ways to stop it.
    const waiting = {
      wait: {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'limit-1',
        waitingSince: '2026-08-28T10:00:00.000Z',
        resumeAt: '2026-08-28T15:00:00.000Z',
      },
    };
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(waiting))).toThrow(
        'Run run-1 is not at a gate: it hit a provider usage or rate limit and tries again by itself at 2026-08-28T15:00:00.000Z'
      );
    }
  });

  test('an attention wait is not a gate decision', () => {
    const waiting = {
      wait: {
        owner: 'node',
        nodeId: 'rerun-ci',
        kind: 'attention',
        waitingSince: '2026-08-28T10:00:00.000Z',
        message: 'Re-run CI, then resume.',
      },
    };
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(waiting))).toThrow('paused at an attention wait');
    }
  });
});
