import type { ReactElement, ReactNode } from 'react';
import { FactoryErrors } from '../FactoryFrame';
import { OverviewBody } from '../overview/OverviewPage';
import type { FactoryPackListed } from '../lib/views';
import { PackFrame } from './PackFrame';
import { PackLookup, packHeading } from './PackLookup';

/**
 * `/console/factory/:pack/how-it-works`: How it works for one pack, from the overview file the
 * server chose (the pack's own, else a project's copy, said behind the header's Source toggle).
 * A pack explains the factory on every project that runs it, so its page lives in the sidebar,
 * not in a project, and names none (owner change of 2026-11-23): a project's own setup is that
 * project's Factory Settings page.
 */
export function PackPage(): ReactElement {
  return <PackLookup render={pack => <HowItWorks pack={pack} />} />;
}

function HowItWorks({ pack }: { pack: FactoryPackListed }): ReactElement {
  return (
    <PackFrame {...packHeading(pack)} source={<ReadFrom pack={pack} />}>
      <FactoryErrors errors={pack.errors} />
      {pack.overview === null ? null : <OverviewBody overview={pack.overview.declaration} />}
    </PackFrame>
  );
}

/**
 * Which file the page reads: the pack's own, or a copy in a project's checkout, which the page
 * does not name, since the page is the pack's, not that project's.
 */
function ReadFrom({ pack }: { pack: FactoryPackListed }): ReactNode {
  if (pack.overview === null) return 'No readable overview file';
  if (pack.readFrom === null) return "Read from the pack's own overview file";
  return (
    <>
      Read from a project&apos;s copy of the overview file{' '}
      {/* The file's name; its whole path, in the project's checkout, on hover. */}
      <span className="font-mono" title={pack.overview.path}>
        ({pack.overview.path.split(/[\\/]/).at(-1)})
      </span>
    </>
  );
}
