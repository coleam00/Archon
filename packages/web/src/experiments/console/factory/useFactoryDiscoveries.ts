import * as skill from '../skills';
import type { FactoryDiscoveries } from '../skills/factory';
import type { EntityView } from '../store/cache';
import { K } from '../store/keys';
import { useFactoryRead } from './useFactoryRead';

/**
 * What the project's discoveries drains decided: the one reader of `K.factoryDiscoveries`,
 * for the board's "Found by the factory" panel and the Overview's tile. Mount it only where
 * the view declares `discoveries`; the server answers 404 otherwise.
 */
export function useFactoryDiscoveries(projectId: string): EntityView<FactoryDiscoveries> {
  return useFactoryRead(K.factoryDiscoveries(projectId), within =>
    within(signal => skill.getFactoryDiscoveries({ codebaseId: projectId }, { signal }))
  );
}
