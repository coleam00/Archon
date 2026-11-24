import * as skill from '../skills';
import type { FactoryPackSettings } from '../skills/factory';
import type { EntityView } from '../store/cache';
import { K } from '../store/keys';
import { useFactoryRead } from './useFactoryRead';

/** One pack's declared settings and each project's values: the one reader of `K.factoryPackSettings`. */
export function useFactoryPackSettings(packKey: string): EntityView<FactoryPackSettings> {
  return useFactoryRead(K.factoryPackSettings(packKey), within =>
    within(signal => skill.getFactoryPackSettings({ pack: packKey }, { signal }))
  );
}
