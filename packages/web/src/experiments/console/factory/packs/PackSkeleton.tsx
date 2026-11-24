import type { ReactElement } from 'react';
import { SkeletonBlock, SkeletonGroup, SkeletonInnerLine } from '../../components/Skeleton';

/** Rule 6: a sidebar Factory page's cards, as shapes, while the packs are read. */
export function PackSkeleton({ cards = 2 }: { cards?: number }): ReactElement {
  return (
    <SkeletonGroup
      label="Reading the factory packs"
      className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
    >
      {Array.from({ length: cards }, (_, index) => (
        <SkeletonBlock key={index} height="h-36">
          <SkeletonInnerLine width="short" />
          <SkeletonInnerLine />
          <SkeletonInnerLine width="short" />
        </SkeletonBlock>
      ))}
    </SkeletonGroup>
  );
}
