import type { ReactElement, ReactNode } from 'react';
import { Factory } from 'lucide-react';
import { Link, Navigate } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { errorDetail } from '../../lib/http';
import type { FactoryPacksRead } from '../../skills/factory';
import { FactoryErrors } from '../FactoryFrame';
import { FactoryLoading } from '../FactoryLoading';
import { useFactoryPacks } from '../useFactoryPacks';
import { readFailed } from '../lib/deadline';
import { packDisplayName } from '../lib/pack-name';
import { factoryPackPath, type FactoryPackListed } from '../lib/views';
import { PackFrame, PacksFailed } from './PackFrame';
import { PackSkeleton } from './PackSkeleton';

/**
 * `/console/factory`: one card per installed pack with a factory overview file. With one
 * pack and nothing else to report there is nothing to choose, so it opens that pack's page.
 */
export function PackIndexPage(): ReactElement {
  const read = useFactoryPacks();
  const listing = read.data;
  const failed = readFailed(read.error);
  const only = listing === undefined ? undefined : onlyPack(listing);
  if (only !== undefined) return <Navigate replace to={factoryPackPath(only.key)} />;
  return (
    <PackFrame title="Factory" subtitle="The factory packs installed here">
      {failed !== undefined ? (
        <PacksFailed message={errorDetail(failed)} />
      ) : listing === undefined ? (
        <FactoryLoading read={read}>
          <PackSkeleton />
        </FactoryLoading>
      ) : (
        <PackList listing={listing} />
      )}
    </PackFrame>
  );
}

/** The one pack to open directly: listed alone, with no unreadable root or project to show. */
function onlyPack(listing: FactoryPacksRead): FactoryPackListed | undefined {
  if (listing.errors.length > 0 || listing.unreadProjects.length > 0) return undefined;
  return listing.packs.length === 1 ? listing.packs[0] : undefined;
}

function PackList({ listing }: { listing: FactoryPacksRead }): ReactElement {
  return (
    <>
      <FactoryErrors errors={listing.errors} />
      <UnreadProjects projects={listing.unreadProjects} />
      {listing.packs.length === 0 ? (
        <EmptyState
          title="No installed pack has a factory overview"
          hint="A pack shows here once it ships .shared/factory-overview.json, or a project presents it with .archon/packs/<pack key>.factory-overview.json."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {listing.packs.map(pack => (
            <li key={pack.key} className="min-w-0">
              <PackCard pack={pack} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Projects whose files could not be read: a pack they would present may be missing. */
function UnreadProjects({ projects }: { projects: FactoryPacksRead['unreadProjects'] }): ReactNode {
  if (projects.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-console-12 border border-warning/30 bg-warning/10 px-4 py-3"
    >
      <p className="text-console-13 font-medium text-warning">
        Some projects could not be read, so a pack they present may be missing
      </p>
      <ul className="flex flex-col gap-1">
        {projects.map(project => (
          <li key={project.codebaseId} className="text-console-13 text-text-secondary">
            <span className="text-text-primary">{project.name}</span>: {project.error}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One pack: its name, its overview's caption and how many projects run it; the name opens its
 * page. It names no project: the sidebar Factory is the general view of how a pack works
 * (owner change 1 of 2026-11-23). The Visual standard's card, without the top accent bar: that bar is a stage group's colour, and
 * a pack has none.
 */
function PackCard({ pack }: { pack: FactoryPackListed }): ReactElement {
  const count = pack.projects.length;
  return (
    <article className="flex h-full flex-col gap-2 overflow-hidden rounded-console-12 border border-border bg-surface p-3 transition-colors hover:border-border-bright hover:bg-surface-elevated">
      <p className="flex min-w-0 items-center gap-2 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        <Factory aria-hidden className="h-4 w-4 shrink-0" />
        <span className="truncate">Pack</span>
      </p>
      <h2 className="line-clamp-2 text-console-15 font-semibold text-text-primary">
        <Link to={factoryPackPath(pack.key)} title={pack.pack} className="hover:underline">
          {packDisplayName(pack.pack)}
        </Link>
      </h2>
      {pack.overview === null ? (
        <p className="text-console-13 text-error">Overview file is broken</p>
      ) : (
        <p className="line-clamp-2 text-console-13 text-text-secondary">
          {pack.overview.declaration.caption}
        </p>
      )}
      <p className="text-console-13 text-text-tertiary">
        {count === 0
          ? 'Runs on no project yet'
          : `Runs on ${count.toString()} ${count === 1 ? 'project' : 'projects'}`}
      </p>
    </article>
  );
}
