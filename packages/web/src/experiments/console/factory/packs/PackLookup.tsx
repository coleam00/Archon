import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Factory } from 'lucide-react';
import { EmptyNote } from '../../components/EmptyNote';
import { errorDetail } from '../../lib/http';
import { FactoryLoading } from '../FactoryLoading';
import { useFactoryPacks } from '../useFactoryPacks';
import { readFailed } from '../lib/deadline';
import { packDisplayName } from '../lib/pack-name';
import type { FactoryPackListed } from '../lib/views';
import { AllPacksLink, PackFrame, PacksFailed } from './PackFrame';
import { PackSkeleton } from './PackSkeleton';

/**
 * The pack the page's URL names (`:pack`, its key), from the packs list every sidebar Factory
 * page reads; until it is found, the frame says why (loading, failed, or no such pack).
 */
export function PackLookup({
  render,
}: {
  render: (pack: FactoryPackListed) => ReactElement;
}): ReactElement {
  const { pack: packKey = '' } = useParams<{ pack: string }>();
  const read = useFactoryPacks();
  const failed = readFailed(read.error);
  const pack = read.data?.packs.find(listed => listed.key === packKey);
  if (pack !== undefined) return render(pack);
  return (
    <PackFrame title="Factory" subtitle={packKey}>
      {failed !== undefined ? (
        <PacksFailed message={errorDetail(failed)} />
      ) : read.data === undefined ? (
        <FactoryLoading read={read}>
          <PackSkeleton />
        </FactoryLoading>
      ) : (
        <>
          <AllPacksLink />
          <EmptyNote
            icon={Factory}
            sentence={`No installed pack keyed "${packKey}" has a factory overview file.`}
          />
        </>
      )}
    </PackFrame>
  );
}

/**
 * A pack page's header: the pack's name as a person reads it, its id on hover. The overview's
 * own title heads How it works (its breadcrumb's root), so the header does not repeat it.
 */
export const packHeading = (pack: FactoryPackListed): { title: string; titleHint: string } => ({
  title: packDisplayName(pack.pack),
  titleHint: pack.pack,
});
