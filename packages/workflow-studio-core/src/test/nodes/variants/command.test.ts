import { describe, it, expect } from 'bun:test';
import { commandVariant } from '../../../nodes/command';

describe('command variant', () => {
  it('createDefault returns valid empty CommandNodeData', () => {
    const d = commandVariant.createDefault();
    expect(d.command).toBe('');
  });

  it('fromDag extracts the command name', () => {
    const data = commandVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { command: 'classify' },
      raw: { id: 'a', command: 'classify' } as never,
    });
    expect(data).toEqual({ command: 'classify' });
  });

  it('toDag produces { command }', () => {
    expect(commandVariant.toDag({ command: 'classify' })).toEqual({ command: 'classify' });
  });

  it('declares honorsAiFields = true and forbidsRetry = false', () => {
    expect(commandVariant.capabilities.honorsAiFields).toBe(true);
    expect(commandVariant.capabilities.forbidsRetry).toBe(false);
  });

  it('declares library metadata with label and colorToken', () => {
    expect(commandVariant.library.label).toBe('Command');
    expect(commandVariant.library.colorToken).toBe('node-command');
    expect(commandVariant.library.defaultIdHint).toBe('run-command');
  });

  it('round-trips toDag(fromDag(...)) preserving the command name', () => {
    const fromDagInput = {
      base: { id: 'a' },
      variantSpecific: { command: 'classify' },
      raw: { id: 'a', command: 'classify' } as never,
    };
    const data = commandVariant.fromDag(fromDagInput);
    expect(commandVariant.toDag(data)).toEqual({ command: 'classify' });
  });
});
