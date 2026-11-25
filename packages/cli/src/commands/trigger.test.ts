import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { triggerConfigSchema } from '@archon/workflows/schemas/resource-start';
import { fireItemKey, readEventInputs } from './trigger';

const binding = {
  bindingId: 'proof',
  bindingRevision: null,
  hostId: 'host',
  runAsUserId: 'user',
  resource: 'proof:resource',
  overlap: 'queue',
  launch: { cwd: '/project', workflowName: 'proof', inputs: {}, isolation: { kind: 'in-place' } },
};
const unmapped = triggerConfigSchema.parse({ version: 1, sourceInstanceId: 'fire', binding });
const mapped = triggerConfigSchema.parse({
  version: 1,
  sourceInstanceId: 'fire',
  binding,
  item: { field: 'number', prefix: 'issue-' },
});

/** A fire from a run on item-1, with nothing named. */
const fire = { explicit: undefined, noItem: false, recorded: false, eventInputs: { number: 7 } };
const inherited = async (): Promise<string> => 'item-1';

describe('the item a fire starts on', () => {
  test.each([
    ['inherits the firing run item', { config: unmapped }, 'item-1'],
    ['takes the mapped item over the inherited one', { config: mapped }, 'issue-7'],
    ['takes --item over the mapping', { config: mapped, explicit: 'named' }, 'named'],
    ['takes --no-item over the mapping', { config: mapped, noItem: true }, undefined],
    ['takes --no-item over the inherited item', { config: unmapped, noItem: true }, undefined],
    ['keeps a recorded delivery off the mapping', { config: mapped, recorded: true }, undefined],
  ] as const)('%s', async (_, overrides, expected) => {
    expect(await fireItemKey({ ...fire, inherited, ...overrides })).toBe(expected);
  });

  test('refuses a mapped fire whose inputs lack the field', async () => {
    await expect(
      fireItemKey({ ...fire, inherited, config: mapped, eventInputs: { other: 1 } })
    ).rejects.toThrow();
  });
});

const tempRoot = trackTempRoots();

async function inputsFile(inputs: Record<string, unknown>): Promise<string> {
  const root = tempRoot(await mkdtemp(join(tmpdir(), 'archon-fire-inputs-')));
  const file = join(root, 'inputs.json');
  await writeFile(file, JSON.stringify(inputs));
  return file;
}

describe("a fire's event inputs", () => {
  test('--input gives the same event inputs as the equivalent --inputs file', async () => {
    const inputs = await inputsFile({ key: 'issue-946', source: 'github' });
    expect(await readEventInputs({ input: ['key=issue-946', 'source=github'] })).toEqual(
      (await readEventInputs({ inputs })) ?? {}
    );
  });

  test('refuses an --input without =, naming it', async () => {
    await expect(readEventInputs({ input: ['oops'] })).rejects.toThrow("'oops'");
  });

  test('refuses a name given by both --inputs and --input', async () => {
    const inputs = await inputsFile({ key: 'issue-1', source: 'github' });
    await expect(readEventInputs({ inputs, input: ['key=issue-2'] })).rejects.toThrow(
      "Input 'key' is given by both --inputs and --input"
    );
  });
});
