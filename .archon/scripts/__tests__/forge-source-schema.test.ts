import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORGE_SOURCES } from '../../workflows/sdlc/.shared/forge';

const PACK = join(import.meta.dir, '../../workflows/sdlc');

interface Node {
  id: string;
  output_format?: { properties?: { source?: { enum: string[] } } };
  loop_group?: { nodes: Node[] };
}

test('every pack source output agrees with the selected forge source vocabulary', () => {
  const checked: string[] = [];
  const visit = (file: string, nodes: Node[]): void => {
    for (const node of nodes) {
      const source = node.output_format?.properties?.source;
      if (source !== undefined) {
        expect({ schema: `${file}:${node.id}`, values: source.enum }).toEqual({
          schema: `${file}:${node.id}`, values: [...FORGE_SOURCES],
        });
        checked.push(`${file}:${node.id}`);
      }
      if (node.loop_group) visit(file, node.loop_group.nodes);
    }
  };
  for (const file of new Bun.Glob('*/archon-*.yaml').scanSync(PACK)) {
    const workflow = Bun.YAML.parse(readFileSync(join(PACK, file), 'utf8')) as { nodes: Node[] };
    visit(file, workflow.nodes);
  }
  expect(checked.length).toBeGreaterThan(0);
});
