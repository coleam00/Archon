import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowDefinition } from './schemas';
import { wf, mapOf, nodeById } from './include-expander.fixtures';

describe('expandWorkflowIncludes — when gate combination', () => {
  function parentWith(includeWhen: string, entryWhen: string): Map<string, WorkflowDefinition> {
    const block = wf('gated-blk', [{ id: 'e', prompt: 'e', when: entryWhen }]);
    block.inputs = { gate: { required: true } };
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      {
        id: 'review',
        include: 'gated-blk',
        depends_on: ['gate'],
        when: includeWhen,
        with: { gate: '$gate.output' },
      },
    ]);
    return mapOf(block, parent);
  }

  test('combines the include gate with the entry node own when (both plain, no ||)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go'", "$INPUTS.gate == 'yes'")
    );
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'review__e')?.when).toBe(
      "$gate.output == 'go' && $gate.output == 'yes'"
    );
  });

  test('fails the expansion when the ENTRY own when uses || (precedence would change)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go'", "$INPUTS.gate == 'a' || $INPUTS.gate == 'b'")
    );
    expect(workflows.has('parent')).toBe(false);
    const err = errors.find(e => e.filename === 'parent');
    expect(err?.error).toContain('cannot combine');
    expect(err?.error).toContain('||');
  });

  test('fails the expansion when the INCLUDE gate uses || (precedence would change)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go' || $gate.output == 'stop'", "$INPUTS.gate == 'yes'")
    );
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain('cannot combine');
  });

  test('entry-only when is preserved unchanged when the include has no gate', () => {
    const block = wf('gated-blk', [{ id: 'e', prompt: 'e', when: "$INPUTS.gate == 'yes'" }]);
    block.inputs = { gate: { required: true } };
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      {
        id: 'review',
        include: 'gated-blk',
        depends_on: ['gate'],
        with: { gate: '$gate.output' },
      },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'review__e')?.when).toBe("$gate.output == 'yes'");
  });
});
