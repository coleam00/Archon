/**
 * Links between items, on both SQL stores. Called from each backend's conformance test with
 * its harness factory, after `makeSqlConformanceHarness` has routed the store to that
 * backend's database.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  ItemLinkEndedError,
  ItemLinkNotFoundError,
  ItemLinkOutsideProjectError,
  ItemLinkSelfError,
  itemLinkKindSchema,
} from '@archon/workflows/schemas/item-link';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';
import type { IDatabase } from './adapters/types';

export function describeItemLinkConformance(
  makeHarness: () => Promise<WorkflowStoreHarness & { db: IDatabase }>
): void {
  test('a title is set before the item has a run, replaced, and read with the item and its links', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const titled = await store.recordItemTitle({ projectKey, key: 'whole', title: 'First' });
      expect(titled).toMatchObject({ projectKey, key: 'whole', title: 'First' });
      await store.recordItemTitle({ projectKey, key: 'whole', title: 'Ship the order' });
      // The one item, read by key and by id, and from the other end of a link.
      const read = (await store.getItemRuns(projectKey, 'whole'))?.item;
      expect(read).toEqual({ ...titled, title: 'Ship the order' });
      expect(await store.getItem(titled.id)).toEqual(read ?? null);
      const { link } = await store.recordItemLink({
        projectKey,
        fromKey: 'piece',
        toKey: 'whole',
        kind: 'part_of',
        via: 'cli',
        by: { declared: 'triage-agent' },
        fromRun: null,
      });
      expect([link.from.title, link.to.title]).toEqual([null, 'Ship the order']);
    } finally {
      await harness.close();
    }
  });

  test('a link is recorded once while active, read from both items, ended and kept', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const byCli = { via: 'cli', by: { declared: 'triage-agent' }, fromRun: null } as const;
      // Every kind the schema names is one the database accepts.
      const recorded = [];
      for (const kind of itemLinkKindSchema.options) {
        const result = await store.recordItemLink({
          projectKey,
          fromKey: 'piece',
          toKey: 'whole',
          kind,
          ...byCli,
        });
        expect(result.created).toBe(true);
        recorded.push(result.link);
      }
      const [dependsOn] = recorded;
      if (!dependsOn) throw new Error('no link recorded');
      expect(dependsOn).toMatchObject({
        kind: 'depends_on',
        from: { projectKey, key: 'piece' },
        to: { projectKey, key: 'whole' },
        via: 'cli',
        by: { declared: 'triage-agent' },
        ended: null,
      });

      // The same kind, direction and items again: one link, the same one.
      const again = await store.recordItemLink({
        projectKey,
        fromKey: 'piece',
        toKey: 'whole',
        kind: 'depends_on',
        via: 'api',
        by: null,
        fromRun: null,
      });
      expect(again).toEqual({ link: dependsOn, created: false });
      // The opposite direction is a different link.
      const back = await store.recordItemLink({
        projectKey,
        fromKey: 'whole',
        toKey: 'piece',
        kind: 'depends_on',
        ...byCli,
      });
      expect(back.created).toBe(true);

      // Both sides list every link from or to them, in recording order.
      const piece = await store.getItemRuns(projectKey, 'piece');
      const whole = await store.getItemRuns(projectKey, 'whole');
      const all = [...recorded, back.link];
      expect(await store.listItemLinks(piece?.item.id ?? '')).toEqual(all);
      expect(await store.listItemLinks(whole?.item.id ?? '')).toEqual(all);

      // A link from an item to itself is refused and writes no link.
      await expect(
        store.recordItemLink({
          projectKey,
          fromKey: 'piece',
          toKey: 'piece',
          kind: 'part_of',
          ...byCli,
        })
      ).rejects.toBeInstanceOf(ItemLinkSelfError);

      // An end scoped to another project is refused and changes nothing.
      await expect(
        store.endItemLink({ linkId: dependsOn.id, projectKey: 'other/project', ...byCli })
      ).rejects.toBeInstanceOf(ItemLinkOutsideProjectError);
      const beforeEnd = Date.now();
      const ended = await store.endItemLink({
        linkId: dependsOn.id,
        projectKey,
        via: 'cli',
        by: { declared: 'alice' },
        fromRun: null,
      });
      // The original fact is unchanged; the end records who and when.
      expect(ended).toEqual({ ...dependsOn, ended: expect.any(Object) });
      expect(ended.ended).toMatchObject({ via: 'cli', by: { declared: 'alice' }, fromRun: null });
      // The end time is when the end was written, not when the link was.
      const endedAt = Date.parse(ended.ended?.at ?? '');
      expect(endedAt).toBeGreaterThanOrEqual(beforeEnd);
      expect(endedAt).toBeLessThanOrEqual(Date.now());
      await expect(store.endItemLink({ linkId: dependsOn.id, ...byCli })).rejects.toBeInstanceOf(
        ItemLinkEndedError
      );
      await expect(store.endItemLink({ linkId: 'no-such-link', ...byCli })).rejects.toBeInstanceOf(
        ItemLinkNotFoundError
      );

      // Once ended, the same link can be recorded again as a new active link.
      const renewed = await store.recordItemLink({
        projectKey,
        fromKey: 'piece',
        toKey: 'whole',
        kind: 'depends_on',
        ...byCli,
      });
      expect(renewed.created).toBe(true);
      expect(renewed.link.id).not.toBe(dependsOn.id);
      const listed = await store.listItemLinks(piece?.item.id ?? '');
      expect(listed[0]).toEqual(ended);
      expect(listed.at(-1)).toEqual(renewed.link);

      // The database refuses a self-link, as a backstop to the store.
      const pieceId = piece?.item.id ?? '';
      await expect(
        db.query(
          "INSERT INTO remote_agent_item_links (from_item_id, to_item_id, kind, via) VALUES ($1, $1, 'part_of', 'cli')",
          [pieceId]
        )
      ).rejects.toThrow();
      // The kind is checked in code, not by the database, so a newer binary can add one.
      // This binary reads a kind it does not know as unreadable; the rest of the item reads.
      const newer = await db.query<{ id: string }>(
        "INSERT INTO remote_agent_item_links (from_item_id, to_item_id, kind, via) VALUES ($1, $2, 'same_as', 'cli') RETURNING id",
        [pieceId, whole?.item.id ?? '']
      );
      const newerLinks = await store.listItemLinks(pieceId);
      expect(newerLinks).toContainEqual({
        type: 'degraded',
        reason: 'link_unreadable',
        linkId: newer.rows[0]?.id,
      });
      expect(newerLinks).toContainEqual(renewed.link);
      // The renewed link is active, so the database refuses a second active row for it:
      // the partial unique index, not the store's code, keeps an active link stored once.
      await expect(
        db.query(
          "INSERT INTO remote_agent_item_links (from_item_id, to_item_id, kind, via) VALUES ($1, $2, 'depends_on', 'cli')",
          [pieceId, whole?.item.id ?? '']
        )
      ).rejects.toThrow();

      // A row that does not read is reported in its place.
      await db.query('UPDATE remote_agent_item_links SET via = $1 WHERE id = $2', [
        'Not A Surface',
        back.link.id,
      ]);
      expect(await store.listItemLinks(pieceId)).toContainEqual({
        type: 'degraded',
        reason: 'link_unreadable',
        linkId: back.link.id,
      });
    } finally {
      await harness.close();
    }
  });
}
