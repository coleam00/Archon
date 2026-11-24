import type { ReactElement } from 'react';
import { FileQuestionMark } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { EmptyNote } from '../components/EmptyNote';
import { BackLink } from './BackLink';
import { FactoryFrame } from './FactoryFrame';
import { factoryPath } from './lib/views';

/** A way on from a page that is not there: here, and on a missing item, stage or step. */
export const WAY_ON_LINK =
  'text-accent-bright transition-colors duration-150 ease-out hover:underline';

/**
 * The tab's two pages, linked from a path it does not have. Needs you is the project tab
 * above, and How it works the sidebar Factory page; neither is a page of this tab.
 */
const PAGES: readonly { label: string; to: (projectId: string) => string }[] = [
  { label: 'Overview', to: projectId => factoryPath(projectId) },
  { label: 'Board', to: projectId => factoryPath(projectId, '/board') },
];

/**
 * `/console/p/:projectId/factory/*`: any path the section does not have. It stays inside the
 * section, with the project and its view, rather than dropping to All projects.
 */
export function FactoryNotFound(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return (
    <FactoryFrame section={null}>
      {() => (
        <div className="flex flex-col gap-6">
          <BackLink to={factoryPath(projectId)} label="Overview" />
          <EmptyNote
            icon={FileQuestionMark}
            sentence="No page here. The Factory has these pages:"
            link={
              <nav aria-label="Factory pages" className="flex flex-wrap items-center gap-3">
                {PAGES.map(({ label, to }) => (
                  <Link key={label} to={to(projectId)} className={WAY_ON_LINK}>
                    {label}
                  </Link>
                ))}
              </nav>
            }
          />
        </div>
      )}
    </FactoryFrame>
  );
}
