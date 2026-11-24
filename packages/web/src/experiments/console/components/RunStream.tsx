import { Fragment, useMemo, type ReactElement } from 'react';
import { MessageItem } from './MessageItem';
import { PathTokenChip, ToolCallItem, toolCallRow } from './ToolCallItem';
import { HookEventItem } from './HookEventItem';
import { NodeDivider } from './NodeDivider';
import { ArtifactItem } from './ArtifactItem';
import type { TextEvent, ArtifactEvent } from '../primitives/event';
import type { PathToken } from '../lib/run-paths';
import {
  foldSections,
  quietFoldSummary,
  visibleRunLog,
  type BlindEntry,
  type LogSection,
  type RunLog,
  type Turn,
  type TurnItem,
} from '../lib/run-log';
import { StreamCard } from './StreamCard';

interface RunStreamProps {
  /** The run's log model (lib/run-log.ts), before the toggles below are applied. */
  log: RunLog;
  /** The run's known paths, longest first (lib/run-paths.ts). */
  pathTokens: readonly PathToken[];
  /** Show every tool call exactly as recorded instead of shortening known paths. */
  fullPaths: boolean;
  showToolCalls: boolean;
  showSystem: boolean;
  /** null shows every node; otherwise restrict the stream to one node's entries. */
  selectedNodeId: string | null;
  /** The run is running or paused, so more entries can still arrive. */
  live: boolean;
  /** The node a paused run waits at; the engine still reports it as running. */
  waitingNodeId: string | null;
}

interface RowDisplay {
  /** The paths rows shorten: none when the stream shows full paths. */
  paths: readonly PathToken[];
  fullPaths: boolean;
  showSystem: boolean;
  waitingNodeId: string | null;
}

const NO_PATHS: readonly PathToken[] = [];

/**
 * The path tokens a section puts on screen. `checkout` is set when a row left out its
 * `cd <checkout> && `, which the section then says once, under its divider.
 */
function sectionPaths(
  section: LogSection,
  paths: readonly PathToken[]
): { checkout: PathToken | undefined; tokens: PathToken[] } {
  const rows = section.turns.flatMap(turn =>
    turn.items.flatMap(item => (item.kind === 'tool' ? [toolCallRow(item.call, paths)] : []))
  );
  const checkout = rows.some(row => row.droppedCheckoutPrefix)
    ? paths.find(token => token.kind === 'checkout')
    : undefined;
  return {
    checkout,
    tokens: [...rows.flatMap(row => row.tokens), ...(checkout !== undefined ? [checkout] : [])],
  };
}

/**
 * The run log: one section per node, in start order. A section is the node's divider,
 * then each block of agent text with the tool calls the engine recorded after it, then
 * whatever carries no node (the user's messages, artifacts, run-level events) from that
 * node's stretch of the run. Runs of quiet nodes fold into one line.
 */
export function RunStream({
  log,
  pathTokens,
  fullPaths,
  showToolCalls,
  showSystem,
  selectedNodeId,
  live,
  waitingNodeId,
}: RunStreamProps): ReactElement | null {
  const visible = useMemo(
    () => visibleRunLog(log, { showToolCalls, showSystem, selectedNodeId }),
    [log, showToolCalls, showSystem, selectedNodeId]
  );
  const paths = fullPaths ? NO_PATHS : pathTokens;
  const usedTokens = useMemo(() => {
    const used = new Set(visible.sections.flatMap(section => sectionPaths(section, paths).tokens));
    return paths.filter(token => used.has(token));
  }, [visible, paths]);

  if (visible.leading.length === 0 && visible.sections.length === 0) {
    // Only a live run is still waiting for anything; a finished one has its
    // outcome in the lifecycle line below the stream.
    if (!live) return null;
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-center">
        <div className="flex flex-col items-center gap-2 text-text-tertiary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[color:var(--running)]" />
          <p className="text-sm">Waiting for first event…</p>
        </div>
      </div>
    );
  }

  const display: RowDisplay = { paths, fullPaths, showSystem, waitingNodeId };
  return (
    <div className="flex flex-col">
      <PathKey tokens={usedTokens} />
      {visible.leading.map(entry => renderBlindEntry(entry, fullPaths))}
      {foldSections(visible.sections).map(item =>
        'fold' in item ? (
          <details key={`fold:${item.key}`} className="group border-b border-border/60">
            <summary className="flex cursor-pointer list-none items-center gap-4 py-2.75 font-mono text-console-12 text-text-tertiary hover:text-text-secondary">
              <span className="w-14 shrink-0 text-console-11" aria-hidden>
                <span className="inline-block transition-transform group-open:rotate-90">▸</span>
              </span>
              {quietFoldSummary(item.fold)}
            </summary>
            {item.fold.map(section => (
              <Section key={section.stepName} section={section} display={display} />
            ))}
          </details>
        ) : (
          <Section key={item.stepName} section={item} display={display} />
        )
      )}
    </div>
  );
}

/** What each token on the page stands for. */
function PathKey({ tokens }: { tokens: readonly PathToken[] }): ReactElement | null {
  if (tokens.length === 0) return null;
  return (
    <dl
      aria-label="Path tokens"
      className="mb-2 grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 rounded border border-border bg-surface-inset px-3 py-2 text-console-11"
    >
      {tokens.map(token => (
        <Fragment key={token.kind}>
          <dt>
            <PathTokenChip token={token} />
          </dt>
          <dd className="text-text-secondary">{token.description}</dd>
          <dd className="font-mono text-text-tertiary [overflow-wrap:anywhere]">{token.path}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Section({ section, display }: { section: LogSection; display: RowDisplay }): ReactElement {
  const { node } = section;
  const { checkout } = sectionPaths(section, display.paths);
  return (
    <>
      {node !== null ? (
        <NodeDivider
          nodeId={node.nodeId}
          nodeName={node.nodeName}
          status={node.status}
          durationMs={node.durationMs}
          timestamp={node.startedAt}
          costUsd={node.costUsd}
          costPartial={node.costPartial}
          costScope={node.costScope}
          numTurns={node.numTurns}
          tokens={node.tokens}
          stopReason={node.stopReason}
          skipReason={node.skipReason}
          skipExpr={node.skipExpr}
          fanOutOutcome={node.fanOutOutcome}
          output={node.output}
          error={node.error}
          failureKind={node.failureKind}
          showDetail={display.showSystem}
          waiting={node.nodeId === display.waitingNodeId && node.status === 'running'}
        />
      ) : null}
      {checkout !== undefined ? (
        <p className="ml-18 py-1.5 text-console-11 text-text-tertiary">
          Commands run in <PathTokenChip token={checkout} /> unless they say otherwise
        </p>
      ) : null}
      {section.turns.map(turn => (
        <TurnBlock key={turn.key} turn={turn} display={display} />
      ))}
      {section.trailing.map(entry => renderBlindEntry(entry, display.fullPaths))}
    </>
  );
}

function TurnBlock({ turn, display }: { turn: Turn; display: RowDisplay }): ReactElement {
  return (
    <>
      {turn.text !== null ? (
        <div className="py-4">
          <MessageItem
            variant="log"
            message={{
              id: turn.key,
              role: 'assistant',
              content: turn.text.text,
              timestamp: turn.text.timestamp,
              toolCalls: [],
              error: null,
              category: null,
              dispatch: null,
              workflowResult: null,
            }}
          />
        </div>
      ) : null}
      {turn.items.length > 0 ? (
        <div className="mb-2 ml-4 border-l-2 border-border pl-3">
          {turn.items.map(item => (
            <TurnItemRow key={item.key} item={item} display={display} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function TurnItemRow({ item, display }: { item: TurnItem; display: RowDisplay }): ReactElement {
  switch (item.kind) {
    case 'tool':
      return (
        <ToolCallItem
          call={item.call}
          timestamp={item.timestamp}
          paths={display.paths}
          exact={display.fullPaths}
        />
      );
    case 'hook':
      return <HookEventItem event={item.event} timestamp={item.timestamp} />;
    case 'warning':
      return (
        <div className="py-1">
          <StreamCard timestamp={item.timestamp} kind="system" compact label="Warning">
            <p className="mt-1 whitespace-pre-wrap font-mono text-console-11 text-text-secondary [overflow-wrap:anywhere]">
              {item.message}
            </p>
          </StreamCard>
        </div>
      );
  }
}

function ContentEventItem({ event }: { event: TextEvent | ArtifactEvent }): ReactElement {
  return event.kind === 'text' ? (
    <div className="whitespace-pre-wrap py-4 text-sm text-text-primary">{event.content}</div>
  ) : (
    <ArtifactItem event={event} />
  );
}

function SystemLine({
  timestamp,
  kind,
  label,
  detail,
}: {
  timestamp: string;
  kind: 'system' | 'error';
  label: string;
  detail: string;
}): ReactElement {
  return (
    <div className="py-1">
      <StreamCard
        timestamp={timestamp}
        kind={kind}
        compact
        label={label}
        headerRight={
          detail.length > 0 ? (
            <span className="truncate font-mono text-console-11 text-text-secondary">{detail}</span>
          ) : null
        }
      />
    </div>
  );
}

function renderBlindEntry(entry: BlindEntry, fullPaths: boolean): ReactElement {
  switch (entry.kind) {
    case 'message':
      return (
        <div key={entry.key} className="py-4">
          <MessageItem message={entry.message} variant="log" />
        </div>
      );
    // A message-inline call carries no node, so no node line can say where it ran:
    // its paths stay as recorded.
    case 'tool':
      return (
        <ToolCallItem
          key={entry.key}
          call={entry.call}
          timestamp={entry.timestamp}
          exact={fullPaths}
        />
      );
    case 'system': {
      const ev = entry.event;
      return ev.kind === 'error' ? (
        <SystemLine
          key={entry.key}
          timestamp={ev.timestamp}
          kind="error"
          label="Error"
          detail={ev.message}
        />
      ) : (
        <SystemLine
          key={entry.key}
          timestamp={ev.timestamp}
          kind="system"
          label={ev.label}
          detail={ev.detail}
        />
      );
    }
    case 'system_row':
      return (
        <SystemLine
          key={entry.key}
          timestamp={entry.row.timestamp}
          kind="system"
          label={entry.row.label}
          detail={entry.row.detail}
        />
      );
    default:
      return (
        <div key={entry.key} className="py-1">
          <ContentEventItem event={entry.event} />
        </div>
      );
  }
}
