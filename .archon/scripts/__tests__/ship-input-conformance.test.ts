import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pack = join(import.meta.dir, '../../workflows/sdlc');

it('ship wrapper forwards the block input contract with matching defaults and guidance', () => {
  const wrapper = Bun.YAML.parse(
    readFileSync(join(pack, 'ship-entry/archon-ship.yaml'), 'utf8')
  ) as {
    inputs: Record<string, unknown>;
    nodes: { loop_group?: { nodes: { include?: string; with?: Record<string, string> }[] } }[];
  };
  const block = Bun.YAML.parse(readFileSync(join(pack, 'ship/archon-ship-block.yaml'), 'utf8')) as {
    inputs: Record<string, unknown>;
  };
  const stage = wrapper.nodes
    .flatMap(node => node.loop_group?.nodes ?? [])
    .find(node => node.include === 'archon-ship-block');

  expect(stage).toBeDefined();
  expect(Object.keys(stage?.with ?? {}).sort()).toEqual(Object.keys(block.inputs).sort());
  expect(wrapper.inputs).toEqual(block.inputs);
});
