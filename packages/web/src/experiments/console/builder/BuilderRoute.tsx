/**
 * Fixture-backed `/console/builder` route. Renders `BuilderPage` seeded from
 * PR-1's typed fixtures with a switcher — **no skill verbs, no
 * `store/cache.ts`, no server I/O, no route params**. PR-3 replaces the
 * fixture seed with `loadWorkflow` and adds the `:name` param; this thin
 * component is exactly the surface it swaps out.
 */
import { useState, type ChangeEvent, type ReactElement } from 'react';
import { FIXTURES } from './fixtures';
import { importWorkflowDefinition } from './model';
import { BuilderPage } from './BuilderPage';

const FIXTURE_KEYS = Object.keys(FIXTURES);

export function BuilderRoute(): ReactElement {
  // Default to the richest fixture (multi-node DAG with when/meta coverage).
  const [fixtureKey, setFixtureKey] = useState<string>('mixed');
  const definition = FIXTURES[fixtureKey];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-[14px] font-semibold text-text-primary">Workflow Builder</h1>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
          beta
        </span>
        <span className="text-[11.5px] text-text-tertiary">
          Editing a local fixture — load/save lands in the next milestone.
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-[11.5px] text-text-tertiary">
          Fixture
          <select
            value={fixtureKey}
            onChange={(e: ChangeEvent<HTMLSelectElement>): void => {
              setFixtureKey(e.target.value);
            }}
            className="rounded-[8px] border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-primary outline-none focus:border-accent-bright/60"
          >
            {FIXTURE_KEYS.map(key => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="min-h-0 flex-1">
        {definition !== undefined ? (
          // Key by fixture so switching remounts the editor with fresh state.
          <BuilderPage
            key={fixtureKey}
            initialWorkflow={importWorkflowDefinition(definition, fixtureKey)}
          />
        ) : null}
      </div>
    </div>
  );
}
