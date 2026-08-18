import { describe, test, expect } from 'bun:test';
import {
  assertWorkflowRequirementsMet,
  WorkflowRequirementError,
  assertComposedGateDriveable,
  ComposedApprovalGateError,
  findComposedApprovalGate,
  resolveTopLevelInputs,
  WorkflowMissingInputsError,
} from './workflow-requirements';
import { WorkflowInputContractError } from '../workflow-inputs';
import { expandWorkflowIncludes } from '../include-expander';
import { dagNodeSchema } from '../schemas';
import type { WorkflowDefinition } from '../schemas';

describe('assertWorkflowRequirementsMet', () => {
  test('passes when there are no requirements', () => {
    expect(() => assertWorkflowRequirementsMet({}, { githubConnected: false })).not.toThrow();
    expect(() =>
      assertWorkflowRequirementsMet({ requires: [] }, { githubConnected: false })
    ).not.toThrow();
  });

  test('passes when github is required and the user is connected', () => {
    expect(() =>
      assertWorkflowRequirementsMet({ requires: ['github'] }, { githubConnected: true })
    ).not.toThrow();
  });

  test('throws WorkflowRequirementError when github is required but not connected', () => {
    let thrown: unknown;
    try {
      assertWorkflowRequirementsMet({ requires: ['github'] }, { githubConnected: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowRequirementError);
    expect((thrown as WorkflowRequirementError).requirement).toBe('github');
    // user-facing message names a connect path
    expect((thrown as WorkflowRequirementError).message).toContain('connect github');
  });
});

describe('resolveTopLevelInputs (#2470, #2554)', () => {
  test('returns undefined with no declared inputs and nothing supplied', () => {
    expect(resolveTopLevelInputs({}, undefined)).toBeUndefined();
    expect(resolveTopLevelInputs({ inputs: {} }, undefined)).toBeUndefined();
  });

  test('passes when all declared inputs are optional or defaulted', () => {
    expect(
      resolveTopLevelInputs(
        { inputs: { a: { default: 'x' }, b: { description: 'opt' } } },
        undefined
      )
    ).toBeUndefined();
  });

  test('returns ONLY the supplied values — declared defaults stay derived at execution', () => {
    // `style` has a default, but nothing was supplied for it, so it must not appear here:
    // persisting a derived default would freeze a snapshot of the workflow's current YAML.
    expect(
      resolveTopLevelInputs(
        { name: 'block', inputs: { diff: { required: true }, style: { default: 'strict' } } },
        { diff: 'D' }
      )
    ).toEqual({ diff: 'D' });
  });

  test('a required input that IS supplied satisfies the gate — the whole point of #2554', () => {
    expect(
      resolveTopLevelInputs(
        { name: 'block', inputs: { diff: { required: true }, plan: { required: true } } },
        { diff: 'D', plan: 'P' }
      )
    ).toEqual({ diff: 'D', plan: 'P' });
  });

  test('throws naming missing required inputs, and names the channels that can supply them', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs(
        {
          name: 'block',
          inputs: { diff: { required: true }, plan: { required: true }, style: { default: 's' } },
        },
        undefined
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowMissingInputsError);
    const err = thrown as WorkflowMissingInputsError;
    expect(err.missing).toEqual(['diff', 'plan']);
    expect(err.message).toContain("'diff', 'plan'");
    expect(err.message).toContain('--input');
    expect(err.message).toContain('console');
    // The framing this issue removed: a required-input workflow is NOT uncallable.
    expect(err.message).not.toContain('reusable block');
  });

  test('throws when only SOME required inputs are supplied, naming just the missing one', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs(
        { name: 'block', inputs: { diff: { required: true }, plan: { required: true } } },
        { diff: 'D' }
      );
    } catch (err) {
      thrown = err;
    }
    expect((thrown as WorkflowMissingInputsError).missing).toEqual(['plan']);
  });

  test('rejects an undeclared key the same way a composing `with:` map is rejected', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs({ name: 'block', inputs: { style: {} } }, { stlye: 'terse' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowInputContractError);
    const err = thrown as WorkflowInputContractError;
    expect(err.undeclared).toEqual(['stlye']);
    expect(err.message).toContain('stlye');
    expect(err.message).toContain('style');
  });

  test('a workflow declaring no inputs keeps Phase-1 passthrough for supplied values', () => {
    expect(resolveTopLevelInputs({ name: 'legacy' }, { anything: 'goes' })).toEqual({
      anything: 'goes',
    });
  });
});

// ---------------------------------------------------------------------------
// Composed approval gates (#1764)
// ---------------------------------------------------------------------------

describe('assertComposedGateDriveable', () => {
  const gateBlock = (): WorkflowDefinition => ({
    name: 'gate-blk',
    description: 'gate-blk',
    nodes: [dagNodeSchema.parse({ id: 'gate', approval: { message: 'Approve?' } })],
  });

  const wf = (name: string, nodes: unknown[], extra: object = {}): WorkflowDefinition =>
    ({
      name,
      description: name,
      nodes: nodes.map(n => dagNodeSchema.parse(n)),
      ...extra,
    }) as WorkflowDefinition;

  function expand(defs: readonly WorkflowDefinition[], name: string): WorkflowDefinition {
    const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
    expect(errors).toEqual([]);
    return workflows.get(name)!;
  }

  test('refuses a composed gate, naming the block, the gate and the fix', () => {
    const parent = expand(
      [gateBlock(), wf('parent', [{ id: 'inc', include: 'gate-blk' }])],
      'parent'
    );

    expect(() => assertComposedGateDriveable(parent.nodes)).toThrow(ComposedApprovalGateError);
    try {
      assertComposedGateDriveable(parent.nodes);
    } catch (err) {
      const gateErr = err as ComposedApprovalGateError;
      expect(gateErr.gate).toEqual({ nodeId: 'inc__gate', origin: 'gate-blk' });
      expect(gateErr.message).toContain('gate-blk');
      expect(gateErr.message).toContain('interactive: true');
      expect(gateErr.message).toContain("'workflow:' node");
    }
  });

  test('a gate reached through a non-interactive intermediate is still refused at the run owner', () => {
    // The intermediate block is never asked the question — only the invoked workflow is.
    // Its own lack of `interactive:` neither refuses nor excuses anything.
    const top = expand(
      [
        gateBlock(),
        wf('mid', [{ id: 'i', include: 'gate-blk' }]),
        wf('top', [{ id: 'm', include: 'mid' }]),
      ],
      'top'
    );
    expect(() => assertComposedGateDriveable(top.nodes)).toThrow(ComposedApprovalGateError);
  });

  test("a workflow's OWN approval node is never refused", () => {
    const own = wf('own', [{ id: 'gate', approval: { message: 'Approve?' } }]);
    expect(() => assertComposedGateDriveable(expand([own], 'own').nodes)).not.toThrow();
  });

  test('finds a composed gate nested inside a loop_group body', () => {
    const block = wf('lg-blk', [
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [{ id: 'gate', approval: { message: 'Approve?' } }],
        },
      },
    ]);
    const parent = expand([block, wf('parent', [{ id: 'inc', include: 'lg-blk' }])], 'parent');
    expect(findComposedApprovalGate(parent.nodes)).toEqual({
      nodeId: 'gate',
      origin: 'lg-blk',
    });
  });

  test('a gate-free composition passes', () => {
    const block = wf('plain', [{ id: 'work', prompt: 'work' }]);
    const parent = expand([block, wf('parent', [{ id: 'inc', include: 'plain' }])], 'parent');
    expect(findComposedApprovalGate(parent.nodes)).toBeNull();
    expect(() => assertComposedGateDriveable(parent.nodes)).not.toThrow();
  });
});
