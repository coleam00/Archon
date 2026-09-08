import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { discoveryPublicationFixture } from '../test/discovery-publication-fixture';

let f: Awaited<ReturnType<typeof discoveryPublicationFixture>>;
beforeEach(async () => {
  f = await discoveryPublicationFixture();
});
afterEach(async () => {
  await f.transport.server.stop(true);
});
const preparedSchema = z.object({
  batch_hash: z.string(),
  requires_gate: z.boolean(),
  review: z.string(),
});
async function prepare() {
  const result = await f.script('prepare', { INPUTS_PUBLISH: 'true' });
  expect(result).toMatchObject({ code: 0, stderr: '' });
  return preparedSchema.parse(JSON.parse(result.stdout));
}
function publish(batch: z.infer<typeof preparedSchema>, decision = 'approve') {
  return f.script('publish', { INPUTS_DECISION: decision, INPUTS_BATCH_HASH: batch.batch_hash });
}
function writes() {
  return f.transport.calls.filter(call => call.method !== 'GET');
}

test('default mode has no gate or forge writes and an input alone cannot publish', async () => {
  expect(JSON.parse((await f.script('prepare')).stdout)).toEqual({
    requires_gate: false,
    batch_hash: '',
    review: '',
  });
  expect((await f.script('publish', { INPUTS_PUBLISH: 'true' })).stderr).toContain(
    'native batch approval required'
  );
  expect(writes()).toEqual([]);
});
test('holds a complete exact batch and rejects tampering with either actions or evidence', async () => {
  const batch = await prepare();
  expect(batch.requires_gate).toBe(true);
  expect(batch.review).toContain('Exact public text with `literal` and $(data).');
  expect((await publish(batch, 'reject')).code).toBe(1);
  const path = join(f.artifacts, 'discovery-publication.json');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('Source defect', 'Different approved text'));
  expect((await publish(batch)).stderr).toContain('gate action tamper');
  await writeFile(path, original);
  await writeFile(join(f.artifacts, 'evidence-check.json'), '[]');
  expect((await publish(batch)).stderr).toContain('reviewed evidence or proposals changed');
  expect(writes()).toEqual([]);
});
test('creates exact approved text with owner readback and repeated retry reuses the item', async () => {
  const batch = await prepare();
  expect((await publish(batch)).code).toBe(0);
  const action = z
    .object({ actions: z.array(z.object({ public_body: z.string() })) })
    .parse(JSON.parse(await readFile(join(f.artifacts, 'discovery-publication.json'), 'utf8')))
    .actions[0]!;
  expect(f.transport.items.at(-1)?.body).toBe(action.public_body);
  expect(f.transport.calls.at(-1)?.method).toBe('GET');
  expect((await publish(batch)).code).toBe(0);
  expect(writes()).toHaveLength(1);
}, 20_000);
test('a successful create with a lost response resumes under the same identity', async () => {
  const batch = await prepare();
  f.transport.state.mode = 'write_then_fail';
  expect((await publish(batch)).code).toBe(1);
  expect(writes()).toHaveLength(1);
  f.transport.state.mode = '';
  expect((await publish(batch)).code).toBe(0);
  expect(writes()).toHaveLength(1);
}, 20_000);
test('an exact duplicate appearing during the gate is reused without modifying its text', async () => {
  const batch = await prepare();
  const action = z
    .object({ actions: z.array(z.object({ request: z.object({ marker: z.string() }) })) })
    .parse(JSON.parse(await readFile(join(f.artifacts, 'discovery-publication.json'), 'utf8')))
    .actions[0]!;
  f.transport.items[0].body = action.request.marker + '\nAlready filed during pause';
  expect((await publish(batch)).code).toBe(0);
  expect(f.transport.items[0].body).toEndWith('Already filed during pause');
  expect(writes()).toEqual([]);
  f.transport.items.push(f.transport.makeItem(43, f.transport.items[0].body));
  expect((await publish(batch)).stderr).toContain('ambiguous duplicate markers');
  expect(writes()).toEqual([]);
}, 20_000);
test('incomplete bounded pagination cannot authorize any write', async () => {
  const batch = await prepare();
  f.transport.items.splice(
    0,
    f.transport.items.length,
    ...Array.from({ length: 10000 }, (_, i) => f.transport.makeItem(i + 1))
  );
  expect((await publish(batch)).stderr).toContain('incomplete marker enumeration');
  expect(writes()).toEqual([]);
}, 20_000);
for (const moved of [false, true]) {
  test(
    'holds ' + (moved ? 'moved' : 'dirty') + ' source after approval',
    async () => {
      const batch = await prepare();
      await writeFile(join(f.repo, 'AGENTS.md'), 'Changed source\n');
      if (moved) {
        for (const args of [
          ['add', '.'],
          ['-c', 'core.hooksPath=', 'commit', '-qm', 'move source'],
        ]) {
          expect(
            await Bun.spawn(['git', ...args], { cwd: f.repo, stdout: 'pipe', stderr: 'pipe' })
              .exited
          ).toBe(0);
        }
      }
      expect((await publish(batch)).stderr).toContain(
        moved ? 'source revision moved' : 'dirty source'
      );
      expect(writes()).toEqual([]);
    },
    20_000
  );
}
test('unsupported forge owner refuses with no write', async () => {
  const batch = await prepare();
  await writeFile(
    join(f.root, 'forge.json'),
    JSON.stringify({ hosts: { 'github.com': 'absent-owner' } })
  );
  expect((await publish(batch)).code).toBe(1);
  expect(writes()).toEqual([]);
});
test('unavailable forge and unverified evidence remain proposal-only even with publish=true', async () => {
  for (const overrides of [
    { remote: '', search: [{ item_index: 0, forge_checked: false, matches: [] }] },
    {
      revalidation: [
        { item_index: 0, verdict: 'supported', evidence_refs: [], note: 'Unverified' },
      ],
    },
  ]) {
    await f.transport.server.stop(true);
    f = await discoveryPublicationFixture(false, overrides);
    expect(f.steps.every(step => step.code === 0)).toBe(true);
    expect((await prepare()).requires_gate).toBe(false);
    expect(f.transport.calls).toEqual([]);
  }
}, 20_000);
test('preparation refuses dirty source', async () => {
  await writeFile(join(f.repo, 'untracked.txt'), 'Unreviewed source');
  expect((await f.script('prepare', { INPUTS_PUBLISH: 'true' })).stderr).toContain('dirty source');
  expect(f.transport.calls).toEqual([]);
});
test('updates only the exact issue by canonical comment and recovers a lost response', async () => {
  await f.transport.server.stop(true);
  f = await discoveryPublicationFixture(true);
  const batch = await prepare();
  f.transport.state.mode = 'write_then_fail';
  expect((await publish(batch)).code).toBe(1);
  f.transport.state.mode = '';
  expect((await publish(batch)).code).toBe(0);
  expect((await publish(batch)).code).toBe(0);
  expect(f.transport.comments).toHaveLength(1);
  expect(f.transport.comments[0]?.issue_url).toBe(
    'https://api.github.com/repos/example/repo/issues/42'
  );
  expect(f.transport.items[0].body).toBe('');
  expect(writes()).toHaveLength(1);
  const existing = f.transport.comments[0]!;
  f.transport.comments.push({
    ...existing,
    id: 2,
    html_url: existing.html_url.replace('-1', '-2'),
  });
  expect((await publish(batch)).code).toBe(1);
  expect(writes()).toHaveLength(1);
}, 20_000);
