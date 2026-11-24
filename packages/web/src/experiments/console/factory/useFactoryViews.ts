import * as skill from '../skills';
import type { FactoryViews } from '../skills/factory';
import type { EntityView } from '../store/cache';
import { K } from '../store/keys';
import { useFactoryRead } from './useFactoryRead';

/**
 * The factory views that apply to a project: the one reader of `K.factoryViews`. The project
 * tabs and every Factory page read it, and the cache runs whichever subscriber's loader comes
 * first, so a second reader with its own loader could start the read without a deadline.
 */
export function useFactoryViews(projectId: string): EntityView<FactoryViews> {
  return useFactoryRead(K.factoryViews(projectId), within =>
    within(signal => skill.getFactoryViews({ codebaseId: projectId }, { signal }))
  );
}
