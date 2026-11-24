import * as skill from '../skills';
import type { FactoryPacksRead } from '../skills/factory';
import type { EntityView } from '../store/cache';
import { K } from '../store/keys';
import { useFactoryRead } from './useFactoryRead';

/**
 * Every pack with a factory overview file: the one reader of `K.factoryPacks`. The sidebar
 * entry and the pack pages read it, so they agree on which packs have a page.
 */
export function useFactoryPacks(): EntityView<FactoryPacksRead> {
  return useFactoryRead(K.factoryPacks, within =>
    within(signal => skill.getFactoryPacks({ signal }))
  );
}
