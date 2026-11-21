import { describe, expect, test } from 'bun:test';
import { ItemLandingUnresolvedError, resolveItemLanding } from './item-landing';
import type { ItemLinkRead } from './schemas/item-link';
import type { ItemLanding, ItemLandingDegraded } from './schemas/item-landing';
import type { WorkflowItem } from './schemas/workflow-run';

const act = { by: null, via: 'cli', fromRun: null, at: '2026-11-18T00:00:00.000Z' } as const;

function item(key: string): WorkflowItem {
  return { id: `id-${key}`, projectKey: 'p', key };
}

function partOf(from: string, to: string, ended = false): ItemLinkRead {
  return {
    id: `${from}->${to}`,
    kind: 'part_of',
    from: item(from),
    to: item(to),
    ...act,
    ended: ended ? act : null,
  } as ItemLinkRead;
}

function store(
  branches: Record<string, string | 'unreadable'>,
  links: ItemLinkRead[]
): Parameters<typeof resolveItemLanding>[0] {
  return {
    getItemLanding: async (id): Promise<ItemLanding | ItemLandingDegraded | null> => {
      const branch = branches[id.slice('id-'.length)];
      if (branch === undefined) return null;
      if (branch === 'unreadable')
        return { type: 'degraded', reason: 'landing_unreadable', itemId: id };
      return { branch, recordedAt: act.at, fromRun: null };
    },
    listItemLinks: async id =>
      links.filter(link =>
        'type' in link ? id === 'id-m' : link.from.id === id || link.to.id === id
      ),
  };
}

describe('resolveItemLanding', () => {
  test('an item with nothing recorded and part of nothing lands nowhere of its own', async () => {
    expect(await resolveItemLanding(store({}, []), item('m'))).toBeNull();
  });

  test("the item's own branch wins over its parent's", async () => {
    const landing = await resolveItemLanding(
      store({ m: 'feat/own', wo: 'feat/wo' }, [partOf('m', 'wo')]),
      item('m')
    );
    expect(landing).toEqual({ branch: 'feat/own', from: { kind: 'own' } });
  });

  test('a member inherits the nearest part_of ancestor that records one', async () => {
    const links = [partOf('m', 'wo'), partOf('wo', 'epic')];
    expect(await resolveItemLanding(store({ epic: 'feat/epic' }, links), item('m'))).toEqual({
      branch: 'feat/epic',
      from: { kind: 'part_of', item: item('epic') },
    });
    expect(
      await resolveItemLanding(store({ epic: 'feat/epic', wo: 'feat/wo' }, links), item('m'))
    ).toEqual({ branch: 'feat/wo', from: { kind: 'part_of', item: item('wo') } });
  });

  test('an ended link and an incoming link carry no branch', async () => {
    const links = [partOf('m', 'wo', true), partOf('child', 'm')];
    expect(
      await resolveItemLanding(store({ wo: 'feat/wo', child: 'feat/child' }, links), item('m'))
    ).toBeNull();
  });

  test('a cycle of links ends the walk', async () => {
    const links = [partOf('m', 'a'), partOf('a', 'b'), partOf('b', 'm')];
    expect(await resolveItemLanding(store({}, links), item('m'))).toBeNull();
  });

  test('two parents at one depth with different branches refuse, naming both', async () => {
    const links = [partOf('m', 'a'), partOf('m', 'b')];
    const resolving = resolveItemLanding(store({ a: 'feat/a', b: 'feat/b' }, links), item('m'));
    await expect(resolving).rejects.toThrow(ItemLandingUnresolvedError);
    await expect(resolving).rejects.toThrow(/'a'.*'feat\/a'.*'b'.*'feat\/b'/);
    // The same branch from both is no disagreement.
    expect(
      await resolveItemLanding(store({ a: 'feat/x', b: 'feat/x' }, links), item('m'))
    ).toMatchObject({ branch: 'feat/x' });
  });

  test('an unreadable landing or link on the way refuses instead of falling back', async () => {
    await expect(
      resolveItemLanding(store({ wo: 'unreadable' }, [partOf('m', 'wo')]), item('m'))
    ).rejects.toThrow(ItemLandingUnresolvedError);
    const unreadable: ItemLinkRead = { type: 'degraded', reason: 'link_unreadable', linkId: 'l1' };
    await expect(resolveItemLanding(store({}, [unreadable]), item('m'))).rejects.toThrow(
      /Link 'l1'/
    );
  });
});
