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
      expect(Date.parse(ended.ended?.at ?? '')).toBeGreaterThanOrEqual(Date.parse(dependsOn.at));
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

      // The database refuses what the store refuses, as a backstop.
      const pieceId = piece?.item.id ?? '';
      await expect(
        db.query(
          "INSERT INTO remote_agent_item_links (from_item_id, to_item_id, kind, via) VALUES ($1, $1, 'part_of', 'cli')",
          [pieceId]
        )
      ).rejects.toThrow();
      await expect(
        db.query(
          "INSERT INTO remote_agent_item_links (from_item_id, to_item_id, kind, via) VALUES ($1, $2, 'same_as', 'cli')",
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

  test('two records of the same link at once leave one link', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const input = {
        projectKey,
        fromKey: 'a',
        toKey: 'b',
        kind: 'duplicate_of',
        via: 'cli',
        by: null,
        fromRun: null,
      } as const;
      // Name the items first, so the race is only on the link.
      const first = await store.recordItemLink(input);
      await store.endItemLink({ linkId: first.link.id, via: 'cli', by: null, fromRun: null });
      const results = await Promise.all([store.recordItemLink(input), store.recordItemLink(input)]);
      expect(results.filter(result => result.created)).toHaveLength(1);
      expect(results[0]?.link.id).toBe(results[1]?.link.id);
      const a = await store.getItemRuns(projectKey, 'a');
      const active = (await store.listItemLinks(a?.item.id ?? '')).filter(
        read => 'ended' in read && read.ended === null
      );
      expect(active).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
}
