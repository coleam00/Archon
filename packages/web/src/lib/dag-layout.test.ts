import { describe, expect, it } from 'bun:test';

import type { DagNode } from './api';
import { resolveExecutionNodeDisplay } from './dag-layout';

describe('resolveExecutionNodeDisplay', () => {
  it('uses the node id for command nodes so execution labels match workflow step ids', () => {
    const node = {
      id: 'detect-project',
      command: 'detect-project-command',
    } as DagNode;

    expect(resolveExecutionNodeDisplay(node)).toEqual({
      label: 'detect-project',
      nodeType: 'command',
    });
  });

  it('keeps loop nodes labeled by node id instead of collapsing them to prompt', () => {
    const node = {
      id: 'explore',
      loop: {
        prompt: 'Investigate the request',
        until: 'PLAN_READY',
        max_iterations: 15,
      },
    } as DagNode;

    expect(resolveExecutionNodeDisplay(node)).toEqual({
      label: 'explore',
      nodeType: 'loop',
    });
  });

  it('recognizes script, approval, and cancel nodes for execution badges', () => {
    expect(
      resolveExecutionNodeDisplay({
        id: 'detect-project',
        script: 'detect-project',
        runtime: 'bun',
      } as DagNode)
    ).toEqual({
      label: 'detect-project',
      nodeType: 'script',
    });

    expect(
      resolveExecutionNodeDisplay({
        id: 'review-plan',
        approval: { message: 'Review the proposed plan' },
      } as DagNode)
    ).toEqual({
      label: 'review-plan',
      nodeType: 'approval',
    });

    expect(
      resolveExecutionNodeDisplay({
        id: 'stop-workflow',
        cancel: 'User cancelled the workflow',
      } as DagNode)
    ).toEqual({
      label: 'stop-workflow',
      nodeType: 'cancel',
    });
  });
});
