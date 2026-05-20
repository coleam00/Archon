import { describe, it, expect } from 'vitest';
import { loopVariant } from '../../../nodes/loop';
import type { LoopNodeData } from '../../../nodes/loop';

describe('loop variant', () => {
  it('createDefault returns valid LoopNodeData with empty prompt + sensible defaults', () => {
    const d = loopVariant.createDefault();
    expect(d.loop.prompt).toBe('');
    expect(d.loop.until).toBe('COMPLETE');
    expect(d.loop.max_iterations).toBe(10);
    expect(d.loop.fresh_context).toBe(false);
  });

  it('fromDag carries the loop config verbatim', () => {
    const input = {
      base: {
        id: 'test-loop',
        variant: 'loop',
        label: 'My Loop',
      },
      variantSpecific: {
        loop: {
          prompt: 'test prompt',
          until: 'DONE',
          max_iterations: 5,
          fresh_context: true,
        },
      },
      raw: {} as any,
    };
    const result = loopVariant.fromDag(input);
    expect(result.loop.prompt).toBe('test prompt');
    expect(result.loop.until).toBe('DONE');
    expect(result.loop.max_iterations).toBe(5);
    expect(result.loop.fresh_context).toBe(true);
  });

  it('toDag produces { loop } verbatim', () => {
    const input: LoopNodeData = {
      loop: {
        prompt: 'test prompt',
        until: 'DONE',
        max_iterations: 5,
        fresh_context: true,
      },
    };
    const result = loopVariant.toDag(input);
    expect(result.loop).toEqual({
      prompt: 'test prompt',
      until: 'DONE',
      max_iterations: 5,
      fresh_context: true,
    });
  });

  it('preserves nested foreign keys inside loop config on round-trip', () => {
    const input = {
      base: {
        id: 'test-loop',
        variant: 'loop',
        label: 'My Loop',
      },
      variantSpecific: {
        loop: {
          prompt: 'p',
          until: 'X',
          max_iterations: 1,
          future_loop_knob: 7,
        } as any,
      },
      raw: {} as any,
    };
    const fromDagResult = loopVariant.fromDag(input);
    const toDagResult = loopVariant.toDag(fromDagResult);
    expect(toDagResult.loop).toEqual({
      prompt: 'p',
      until: 'X',
      max_iterations: 1,
      future_loop_knob: 7,
    });
  });

  it('preserves interactive + gate_message + until_bash', () => {
    const input: LoopNodeData = {
      loop: {
        prompt: 'ask user',
        until: 'done',
        max_iterations: 3,
        fresh_context: false,
        interactive: true,
        gate_message: 'Please review and continue',
        until_bash: 'test -f /tmp/done',
      },
    };
    const dagResult = loopVariant.toDag(input);
    expect(dagResult.loop).toEqual({
      prompt: 'ask user',
      until: 'done',
      max_iterations: 3,
      fresh_context: false,
      interactive: true,
      gate_message: 'Please review and continue',
      until_bash: 'test -f /tmp/done',
    });
  });

  it('declares honorsAiFields = true and forbidsRetry = true', () => {
    expect(loopVariant.capabilities.honorsAiFields).toBe(true);
    expect(loopVariant.capabilities.forbidsRetry).toBe(true);
  });

  it('declares library metadata', () => {
    expect(loopVariant.library.label).toBe('Loop');
    expect(loopVariant.library.colorToken).toBe('node-loop');
    expect(loopVariant.library.defaultIdHint).toBe('loop');
  });
});
