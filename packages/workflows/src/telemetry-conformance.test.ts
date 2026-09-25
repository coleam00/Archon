/**
 * `@archon/paths` sits below `@archon/workflows` and cannot import its types, so it
 * mirrors the telemetry vocabularies this package owns. These checks make the mirrors
 * a compile or test failure the moment they drift, instead of a silent wrong enum.
 */
import { describe, expect, test } from 'bun:test';
import type {
  WorkflowCancelReason,
  WorkflowErrorClass,
  WorkflowExitReason,
  WorkflowNodeType,
} from '@archon/paths';
import { nodeFailureKindSchema, type NodeDescriptor } from './schemas/node-execution';
import { runCancelReasonSchema, runExitReasonSchema } from './schemas/run-terminal-reason';
import { telemetryNodeType } from './telemetry-node-type';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const failureKindsMirrored: Same<
  (typeof nodeFailureKindSchema.options)[number],
  WorkflowErrorClass
> = true;
const exitReasonsMirrored: Same<(typeof runExitReasonSchema.options)[number], WorkflowExitReason> =
  true;
const cancelReasonsMirrored: Same<
  (typeof runCancelReasonSchema.options)[number],
  WorkflowCancelReason
> = true;

describe('telemetry vocabularies mirrored in @archon/paths', () => {
  test('failure kinds, exit reasons and cancel reasons are the same sets', () => {
    expect([failureKindsMirrored, exitReasonsMirrored, cancelReasonsMirrored]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test('every telemetry node type is produced by some node kind', () => {
    // One descriptor per discriminator combination the mapping switches on.
    const descriptors: NodeDescriptor[] = [
      { id: 'a', kind: 'agent', source: { kind: 'inline' } },
      { id: 'b', kind: 'agent', source: { kind: 'command', name: 'c' } },
      { id: 'c', kind: 'exec', runtime: 'sh' },
      { id: 'd', kind: 'exec', runtime: 'bun' },
      { id: 'e', kind: 'loop' },
      { id: 'f', kind: 'loop_group' },
      { id: 'g', kind: 'gate' },
      { id: 'h', kind: 'wait' },
      { id: 'i', kind: 'halt' },
      { id: 'j', kind: 'workflow' },
      { id: 'k', kind: 'compose_fan_out' },
      { id: 'l', kind: 'compose_fan_out_instance' },
    ];
    const produced = new Set(descriptors.map(telemetryNodeType));
    const all = {
      command: true,
      prompt: true,
      bash: true,
      script: true,
      loop: true,
      loop_group: true,
      approval: true,
      wait: true,
      workflow: true,
      cancel: true,
      compose_fan_out: true,
    } satisfies Record<WorkflowNodeType, true>;
    expect([...produced].map(String).sort()).toEqual(Object.keys(all).sort());
  });
});
