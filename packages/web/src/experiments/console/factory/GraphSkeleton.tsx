import type { ReactElement } from 'react';
import { SkeletonBlock, SkeletonGroup, SkeletonInnerLine } from './ui/Skeleton';

/**
 * A step graph or a step's page still loading: the graph frame's shape (Visual standard, rule
 * 6), never "Loading…".
 */
export function GraphSkeleton({ label }: { label: string }): ReactElement {
  return (
    <SkeletonGroup label={label}>
      <SkeletonBlock height="h-64">
        <SkeletonInnerLine width="short" />
        <SkeletonInnerLine />
      </SkeletonBlock>
    </SkeletonGroup>
  );
}
