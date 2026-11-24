import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { useProjectAttention } from '../components/ProjectAttention';
import { needsYouCount } from '../lib/needs-you';
import { FactoryFrame } from './FactoryFrame';
import { FactoryNumbers } from './FactoryNumbers';
import { FactoryMap } from './map/FactoryMap';
import { OverviewAsks } from './OverviewAsks';
import { useFactoryItems } from './useFactoryItems';

/** `/console/p/:projectId/factory`: what this factory does, its numbers, what needs a person, then the map. */
export function FactoryPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  // The items the numbers and the map read already: Need you counts those waiting on you too.
  const items = useFactoryItems(projectId);
  const attention = useProjectAttention();
  return (
    // Wide: the map takes the page's whole width; the text above it keeps its own measure.
    <FactoryFrame section="overview" wide>
      {view => (
        <>
          <FactoryNumbers
            projectId={projectId}
            view={view.declaration}
            waiting={
              attention.data === undefined || items.data === undefined
                ? undefined
                : needsYouCount(attention.data, items.data)
            }
          />
          <OverviewAsks projectId={projectId} view={view} />
          <FactoryMap projectId={projectId} view={view} />
        </>
      )}
    </FactoryFrame>
  );
}
