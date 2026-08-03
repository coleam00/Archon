import type { ReactElement } from 'react';
import { ActiveRunCard } from './ActiveRunCard';
import { RecentRunRow } from './RecentRunRow';
import type { Run } from '../primitives/run';

interface RunCardProps {
  run: Run;
  showProject?: boolean;
}

/**
 * Dispatcher — renders the right visual for a run based on its status.
 *
 *   running / paused    → ActiveRunCard (rich, attention-grabbing)
 *   completed / failed  → RecentRunRow (compact one-liner)
 *   cancelled           → RecentRunRow
 *
 * The split matches the attention model: active work gets real estate, the
 * audit trail stays quiet. The RunsPage splits sections, but this dispatcher
 * keeps the preview route and any mixed-list usage simple.
 */
export function RunCard({ run, showProject = false }: RunCardProps): ReactElement {
  if (run.status === 'running' || run.status === 'paused') {
    return <ActiveRunCard run={run} showProject={showProject} />;
  }
  return <RecentRunRow run={run} showProject={showProject} />;
}
