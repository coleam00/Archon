import type { CSSProperties, ReactElement } from 'react';
import { RunCard } from '../components/RunCard';
import { ProjectTile } from '../components/ProjectTile';
import { OriginBadge } from '../components/OriginBadge';
import type { Run } from '../primitives/run';

/**
 * Visual preview of the console's warm palette in context.
 * Route: /console/_preview. Not part of the product flow — a living reference
 * while we pin down the theme.
 */

const baseRun: Omit<Run, 'id' | 'workflow' | 'status'> = {
  projectId: 'demo',
  projectName: 'archon-core',
  costUsd: null,
  conversationId: null,
  conversationPlatformId: null,
  origin: 'cli',
  startedAt: new Date(Date.now() - 4 * 60 * 1000 - 12 * 1000).toISOString(),
  finishedAt: null,
  workingPath: null,
  userMessage: '',
};

const SAMPLE_RUNS: Run[] = [
  {
    ...baseRun,
    id: 'a4f2c918-running',
    workflow: 'plan',
    status: 'running',
    currentNode: 'plan/draft',
    lastTool: 'read_file',
  },
  {
    ...baseRun,
    id: '8f3d2a1c-paused',
    workflow: 'review',
    origin: 'web',
    status: 'paused',
    startedAt: new Date(Date.now() - 14 * 60 * 1000 - 22 * 1000).toISOString(),
    approval: {
      nodeId: 'implement/verify',
      message: 'Approve running bun validate?',
    },
  },
  {
    ...baseRun,
    id: 'c1a5b9d3-failed',
    workflow: 'test',
    origin: 'slack',
    status: 'failed',
    startedAt: new Date(Date.now() - 2 * 60 * 1000 - 41 * 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    currentNode: 'implement/verify',
  },
  {
    ...baseRun,
    id: 'd7e9b4f2-completed',
    workflow: 'implement',
    origin: 'github',
    status: 'completed',
    startedAt: new Date(Date.now() - 8 * 60 * 1000 - 14 * 1000).toISOString(),
    finishedAt: new Date().toISOString(),
  },
  {
    ...baseRun,
    id: 'e5b3c742-cancelled',
    workflow: 'assist',
    origin: 'telegram',
    status: 'cancelled',
    startedAt: new Date(Date.now() - 47 * 1000).toISOString(),
    finishedAt: new Date().toISOString(),
  },
];

const SAMPLE_PROJECTS = [
  { id: 'archon-core', name: 'archon-core' },
  { id: 'web-ui', name: 'web-ui' },
  { id: 'cli-tool', name: 'cli-tool' },
  { id: 'infra-ops', name: 'infra-ops' },
  { id: 'mobile-app', name: 'mobile-app' },
  { id: 'ml-pipeline', name: 'ml-pipeline' },
  { id: 'docs-site', name: 'docs-site' },
  { id: 'experiments', name: 'experiments' },
];

interface SwatchProps {
  role: string;
  cssVar: string;
  note?: string;
}

function Swatch({ role, cssVar, note }: SwatchProps): ReactElement {
  const chipStyle: CSSProperties = {
    backgroundColor: `var(${cssVar})`,
  };
  return (
    <div className="flex items-center gap-3 rounded border border-border bg-surface px-3 py-2">
      <div style={chipStyle} className="h-10 w-10 shrink-0 rounded" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary">{role}</div>
        <div className="font-mono text-[10px] text-text-tertiary">{cssVar}</div>
        {note !== undefined ? (
          <div className="mt-0.5 text-[11px] text-text-secondary">{note}</div>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-tertiary">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function PreviewPage(): ReactElement {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-base font-medium text-text-primary">Preview · warm palette</h1>
        <p className="text-xs text-text-tertiary">
          Living reference. Not linked from nav. Visit /console/_preview.
        </p>
      </header>

      <main className="mx-auto flex w-full max-w-[1000px] flex-col gap-10 px-6 py-8">
        <Section title="Run cards · every status">
          <div className="flex flex-col gap-2">
            {SAMPLE_RUNS.map(run => (
              <RunCard key={run.id} run={run} showProject={true} />
            ))}
          </div>
        </Section>

        <Section title="Project tiles · hash-based colors">
          <div className="flex flex-wrap gap-3 rounded border border-border bg-surface p-4">
            {SAMPLE_PROJECTS.map((p, i) => (
              <ProjectTile
                key={p.id}
                projectId={p.id}
                name={p.name}
                selected={i === 0}
                onClick={(): void => {
                  /* preview only */
                }}
              />
            ))}
          </div>
          <p className="text-[11px] text-text-tertiary">
            Color seeded deterministically from project id. First tile shown as the
            currently-selected scope.
          </p>
        </Section>

        <Section title="Origin badges">
          <div className="flex flex-wrap gap-2">
            <OriginBadge origin="web" />
            <OriginBadge origin="cli" />
            <OriginBadge origin="slack" />
            <OriginBadge origin="telegram" />
            <OriginBadge origin="discord" />
            <OriginBadge origin="github" />
            <OriginBadge origin="unknown" />
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded bg-accent-bright px-3 py-1.5 text-sm font-medium text-white/95 transition-opacity hover:brightness-110"
            >
              Primary · Add project
            </button>
            <button
              type="button"
              className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-surface-hover"
            >
              Secondary · Cancel
            </button>
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-error hover:bg-error/10"
            >
              Destructive · Remove
            </button>
            <button
              type="button"
              className="rounded bg-success/20 px-3 py-1.5 text-sm font-medium text-success hover:bg-success/30"
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-error hover:underline"
            >
              Reject
            </button>
          </div>
        </Section>

        <Section title="Surfaces">
          <div className="grid grid-cols-2 gap-3">
            <Swatch role="Surface" cssVar="--surface" note="main content bg" />
            <Swatch role="Surface inset" cssVar="--surface-inset" note="rail, inner wells" />
            <Swatch
              role="Surface elevated"
              cssVar="--surface-elevated"
              note="dialogs, popovers, selected chips"
            />
            <Swatch
              role="Surface hover"
              cssVar="--surface-hover"
              note="hover state on rows/cards"
            />
          </div>
        </Section>

        <Section title="Text">
          <div className="grid grid-cols-3 gap-3">
            <Swatch role="Text primary" cssVar="--text-primary" />
            <Swatch role="Text secondary" cssVar="--text-secondary" />
            <Swatch role="Text tertiary" cssVar="--text-tertiary" />
          </div>
        </Section>

        <Section title="Accent (primary CTAs only)">
          <div className="grid grid-cols-3 gap-3">
            <Swatch
              role="Accent bright"
              cssVar="--accent-bright"
              note="Add project, Submit, primary buttons"
            />
            <Swatch role="Accent" cssVar="--accent" />
            <Swatch role="Accent hover" cssVar="--accent-hover" />
          </div>
        </Section>

        <Section title="Status">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Swatch
              role="Running"
              cssVar="--running"
              note="active strip (pulsing) + dot; in-progress"
            />
            <Swatch role="Paused" cssVar="--warning" note="approval card, paused dot (pulsing)" />
            <Swatch role="Failed" cssVar="--error" note="failed strip, reject, destructive" />
            <Swatch
              role="Completed"
              cssVar="--success"
              note="completed strip (muted), check icons, Approve"
            />
          </div>
        </Section>

        <Section title="Borders">
          <div className="grid grid-cols-2 gap-3">
            <Swatch role="Border" cssVar="--border" />
            <Swatch role="Border bright" cssVar="--border-bright" />
          </div>
        </Section>
      </main>
    </div>
  );
}
