/**
 * Is a pack wired on this install? The page reads the pack graph and shows what the pack
 * declares against what the install has: the bindings between stages that are registered,
 * missing or left over, and the bindings work enters by.
 *
 * Every row is the engine's own data and no pack is named. A check with no server read yet
 * (forge operations, versions) is not drawn.
 */
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import * as skill from '../skills';
import { relativeTime } from '../lib/format';
import { getObserving, getPackGraph, type Observing, type PackGraph } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

type Arrow = PackGraph['arrows'][number];

/** An arrow in the pack's own words: the stage and what ended it, then the stage it starts. */
function arrowText({ from, to }: Arrow): string {
  const cause =
    'outcome' in from
      ? `ends ${from.outcome}`
      : `asks ${from.settled}${from.option === undefined ? '' : ` with ${from.option}`}`;
  return `${from.stage} ${cause} → ${to}`;
}

/** The trigger file that registers an arrow; an arrow that is not active has none. */
const installedOf = (arrow: Arrow): { file: string; problems: string[] } | null =>
  arrow.active ? arrow.installed : null;

/** The arrows the pack declares that no trigger file registers, the files no declaration
 * matches, and every problem a registered or declared arrow reports. */
export function bindingState(graph: Pick<PackGraph, 'arrows'>): {
  declared: number;
  registered: number;
  missing: Arrow[];
  leftOver: Arrow[];
  problems: { arrow: Arrow; problem: string }[];
} {
  const declared = graph.arrows.filter(arrow => arrow.declared !== null);
  return {
    declared: declared.length,
    registered: declared.filter(arrow => arrow.active).length,
    missing: declared.filter(arrow => !arrow.active),
    leftOver: graph.arrows.filter(arrow => arrow.declared === null),
    problems: graph.arrows.flatMap(arrow =>
      [...(arrow.declared?.problems ?? []), ...(installedOf(arrow)?.problems ?? [])].map(
        problem => ({
          arrow,
          problem,
        })
      )
    ),
  };
}

function ArrowList({ kind, arrows }: { kind: string; arrows: Arrow[] }): ReactElement | null {
  if (arrows.length === 0) return null;
  return (
    <ul data-arrows={kind} className="mt-2 flex flex-col gap-1 text-console-12 text-text-secondary">
      {arrows.map(arrow => (
        <li key={`${arrowText(arrow)}|${installedOf(arrow)?.file ?? ''}`}>
          <span className="font-mono">{arrowText(arrow)}</span>
          {installedOf(arrow) === null ? '' : ` (${installedOf(arrow)?.file ?? ''})`}
        </li>
      ))}
    </ul>
  );
}

/**
 * Whether a run can find a provider: the install's default, and whether it is one of the
 * providers registered here. Without a default, a stage that names no provider is refused
 * when it starts.
 */
export function providerState(
  defaultProvider: string | undefined,
  registered: readonly string[]
): { ok: boolean; provider: string | null; registered: readonly string[] } {
  const provider = defaultProvider ?? null;
  return { ok: provider !== null && registered.includes(provider), provider, registered };
}

function ProviderCheck(): ReactElement | null {
  const { data: config } = useEntity(K.config, skill.getConfig);
  const { data: providers } = useEntity(K.providers, skill.listProviders);
  if (config === undefined || providers === undefined) return null;
  const state = providerState(
    config.config.assistant,
    providers.map(provider => provider.id)
  );
  return (
    <section data-setup="provider" data-ok={state.ok ? '' : undefined} className="mb-8">
      <h2 className="text-sm font-medium text-text-primary">A provider is configured</h2>
      {state.ok ? (
        <p className="mt-1 text-console-12 text-text-secondary">
          Default provider: <span className="font-mono">{state.provider}</span>
        </p>
      ) : (
        <p className="mt-1 text-console-12 text-error">
          {state.provider === null
            ? 'No default provider is set. A stage that names no provider is refused when it starts.'
            : `The default provider ${state.provider} is not registered on this install.`}{' '}
          <Link className="underline" to="/console/settings">
            Set one in Settings
          </Link>
          .
        </p>
      )}
      <p className="mt-1 text-console-11 text-text-tertiary">
        Registered: {state.registered.length === 0 ? 'none' : state.registered.join(', ')}
      </p>
    </section>
  );
}

/**
 * When the wake watcher last read, and what it reported failing, in the record's own facts.
 * A record that exists but does not read (`lastPassUnreadable`) says so, not "never".
 */
export function watcherLine(
  observing: Pick<Observing, 'lastPass' | 'lastPassUnreadable'>,
  now = Date.now()
): string {
  const { lastPass, lastPassUnreadable } = observing;
  if (lastPassUnreadable !== null)
    return `The wake watcher's last-pass record could not be read: ${lastPassUnreadable}`;
  if (lastPass === null) return 'The wake watcher has never recorded a pass on this install.';
  const read = `The wake watcher last read ${relativeTime(lastPass.at, now)}`;
  const failed = Object.values(lastPass.parts).flatMap(part =>
    part === undefined || part.ok ? [] : part.errors
  );
  if (!lastPass.ok) return `${read}, and that pass failed: ${failed.join('; ')}`;
  if (lastPass.lastFailure === undefined) return `${read}.`;
  return `${read}. It failed a pass ${relativeTime(lastPass.lastFailure.at, now)}: ${lastPass.lastFailure.errors.join('; ')}`;
}

/**
 * What reads event bindings on an install that receives no webhooks. It is the whole
 * install's: the engine cannot tell which project or pack a source's binding belongs to.
 */
function ObservingCheck(): ReactElement | null {
  const { data } = useEntity<Observing>(K.observing, getObserving);
  if (data === undefined) return null;
  const failing = data.lastPassUnreadable !== null || (data.lastPass !== null && !data.lastPass.ok);
  return (
    <div data-observing className="mt-4 text-console-12 text-text-secondary">
      <h3 className="font-semibold">Event bindings read without webhooks, on this install</h3>
      {data.sources.length === 0 ? (
        <p className="mt-1 text-text-tertiary">
          This server was started with no sources file that observes, so it reads none.
          {data.lastPass?.sources === undefined
            ? ''
            : ` The wake watcher last loaded ${data.lastPass.sources}.`}
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {data.sources.map(source => (
            <li key={source.source} data-source={source.source}>
              <span className="font-mono text-text-primary">{source.source}</span>: read every{' '}
              {source.everySeconds} s while this server runs
              <ul className="ml-4">
                {source.labels.map(read => (
                  <li key={`${read.bindingId}|${read.repo.path}|${read.label}`} data-read>
                    <span className="font-mono">{read.bindingId}</span>: label{' '}
                    <span className="font-mono">{read.label}</span> on {read.repo.host}/
                    {read.repo.path}
                  </li>
                ))}
                {source.unserved.map(binding => (
                  <li key={binding.bindingId} data-unserved className="text-warning">
                    <span className="font-mono">{binding.bindingId}</span> is not read:{' '}
                    {binding.reason}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p data-watcher className={`mt-2 ${failing ? 'text-error' : ''}`}>
        {watcherLine(data)}
      </p>
      <p className="mt-1 text-console-11 text-text-tertiary">
        Whether a job runs the watcher on this host:{' '}
        <span className="font-mono">archon workflow wake schedule status</span>. A fire binding
        starts with <span className="font-mono">archon trigger fire --config &lt;file&gt;</span>,
        where the file is the one <span className="font-mono">archon pack bindings</span> wrote to
        its <span className="font-mono">--out</span> directory.
      </p>
    </div>
  );
}

export function PackSetup({ graph }: { graph: PackGraph }): ReactElement {
  const state = bindingState(graph);
  const heading = 'text-sm font-medium text-text-primary';
  return (
    <>
      <section data-setup="bindings" className="mb-8">
        <h2 className={heading}>Bindings between stages</h2>
        <p data-binding-counts className="mt-1 text-console-12 text-text-secondary">
          {state.registered} of {state.declared} declared are registered on this install
          {state.leftOver.length === 0 ? '' : `, ${String(state.leftOver.length)} left over`}
        </p>
        {state.missing.length > 0 ? (
          <h3 className="mt-3 text-console-12 font-semibold text-warning">
            Declared, not registered: these start nothing
          </h3>
        ) : null}
        <ArrowList kind="missing" arrows={state.missing} />
        {state.leftOver.length > 0 ? (
          <h3 className="mt-3 text-console-12 font-semibold text-warning">
            Registered, not declared by the pack
          </h3>
        ) : null}
        <ArrowList kind="left-over" arrows={state.leftOver} />
        {state.problems.length > 0 ? (
          <ul
            data-arrows="problems"
            className="mt-3 flex flex-col gap-1 text-console-12 text-error"
          >
            {state.problems.map(({ arrow, problem }) => (
              <li key={`${arrowText(arrow)}|${problem}`}>
                <span className="font-mono">{arrowText(arrow)}</span>: {problem}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section data-setup="entries" className="mb-8">
        <h2 className={heading}>How work gets in</h2>
        {graph.entries.length === 0 ? (
          <p className="mt-1 text-console-12 text-text-tertiary">
            The pack declares no timer, event or fire binding: a stage is started by hand.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-console-12 text-text-secondary">
            {graph.entries.map(entry => (
              <li key={entry.binding} data-entry={entry.binding}>
                <span className="font-mono text-text-primary">{entry.binding}</span>: a {entry.kind}{' '}
                binding that starts <span className="font-mono">{entry.stage}</span>
              </li>
            ))}
          </ul>
        )}
        <ObservingCheck />
      </section>
      {graph.stages.some(stage => stage.inFlow && stage.roles.length > 0) ? (
        <section data-setup="roles" className="mb-8">
          <h2 className={heading}>Which roles each stage names</h2>
          <p className="mt-1 text-console-12 text-text-tertiary">
            A role is a model alias. A binding's run config, the project or the install can set it;
            this page does not resolve which one does. Unset, the stage runs on the tier or model
            shown.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-console-12 text-text-secondary">
            {graph.stages
              .filter(stage => stage.inFlow && stage.roles.length > 0)
              .map(stage => (
                <li key={stage.name} data-roles={stage.workflow}>
                  <span className="font-mono text-text-primary">{stage.workflow}</span>:{' '}
                  {stage.roles.map(({ role, fallback }) => `${role} (else ${fallback})`).join(', ')}
                </li>
              ))}
          </ul>
        </section>
      ) : null}
      {graph.capacity.length > 0 ? (
        <section data-setup="capacity" className="mb-8">
          <h2 className={heading}>How much runs at once</h2>
          <ul className="mt-2 flex flex-col gap-1 text-console-12 text-text-secondary">
            {graph.capacity.map(slot => (
              <li key={slot.resource} data-resource={slot.resource}>
                <span className="font-mono text-text-primary">{slot.stages.join(' · ')}</span>:{' '}
                <span data-held>{slot.held}</span> of{' '}
                <span data-limit>{slot.limit ?? slot.declared ?? 1}</span> running
                {slot.limit !== null && slot.declared !== null && slot.limit !== slot.declared
                  ? ` (the binding declares ${String(slot.declared)})`
                  : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {graph.discoveryErrors.length > 0 ? (
        <section data-setup="errors" className="mb-8">
          <h2 className={heading}>Workflows that did not load</h2>
          <ul className="mt-2 flex flex-col gap-1 text-console-12 text-error">
            {graph.discoveryErrors.map(failure => (
              <li key={`${failure.filename}|${failure.error}`}>
                <span className="font-mono">{failure.filename}</span>: {failure.error}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function PackSetupPage(): ReactElement {
  const { projectId = '', pack = '' } = useParams<{ projectId: string; pack: string }>();
  const { data: graph, error } = useEntity<PackGraph>(K.packGraph(projectId, pack), () =>
    getPackGraph(projectId, pack)
  );
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-4 py-4 md:px-6">
        <h1 className="truncate text-base font-medium text-text-primary">{pack}: setup</h1>
        <p className="text-xs text-text-tertiary">
          <Link className="underline" to={`/console/p/${encodeURIComponent(projectId)}/board`}>
            Back to the board
          </Link>
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4 md:px-6">
        {error !== undefined ? <p className="text-console-12 text-error">{error.message}</p> : null}
        {graph === undefined && error === undefined ? (
          <p className="text-console-12 text-text-tertiary">Reading the pack…</p>
        ) : null}
        <ProviderCheck />
        {graph === undefined ? null : <PackSetup graph={graph} />}
      </div>
    </section>
  );
}
