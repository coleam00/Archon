import { describe, it, expect, beforeEach } from 'bun:test';
import { insertSnippet } from '../../snippets/insertSnippet';
import { useBuilderStore } from '../../store/builder-store';

const trivialSnippetYaml = `
name: pattern-classify-then-branch
description: Classify input, branch on result.
nodes:
  - id: classify
    command: classify
  - id: branch-yes
    prompt: "$classify.output is yes"
    depends_on: [classify]
    when: "$classify.output == 'yes'"
  - id: branch-no
    prompt: "$classify.output is no"
    depends_on: [classify]
    when: "$classify.output == 'no'"
`;

beforeEach(() =>
  useBuilderStore.getState().loadWorkflow({
    meta: { name: 'host', description: '', base: {}, unknown: {} },
    nodes: [{ id: 'classify', variant: 'command', data: { command: 'x' }, base: {}, unknown: {} }],
  })
);

describe('insertSnippet', () => {
  it('renames colliding ids and preserves depends_on / when wiring', () => {
    const positions = new Map<string, { x: number; y: number }>();
    const setPosition = (id: string, p: { x: number; y: number }) => positions.set(id, p);
    const result = insertSnippet({
      yaml: trivialSnippetYaml,
      anchorPosition: { x: 500, y: 300 },
      setPosition,
    });
    const ids = useBuilderStore.getState().nodes.map(n => n.id);
    expect(ids).toContain('classify'); // host node untouched
    expect(ids).toContain('classify-2'); // colliding snippet id renamed
    expect(ids).toContain('branch-yes');
    expect(ids).toContain('branch-no');
    const yes = useBuilderStore.getState().nodes.find(n => n.id === 'branch-yes')!;
    expect(yes.base.depends_on).toEqual(['classify-2']);
    expect(yes.base.when).toBe("$classify-2.output == 'yes'");
    expect(result.insertedIds).toEqual(['classify-2', 'branch-yes', 'branch-no']);
    expect(positions.size).toBe(3);
    for (const id of result.insertedIds) expect(positions.has(id)).toBe(true);
  });
});
