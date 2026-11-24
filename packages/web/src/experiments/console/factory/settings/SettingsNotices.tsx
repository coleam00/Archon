import { type ReactElement, type ReactNode, useId } from 'react';
import { SlidersHorizontal, TriangleAlert } from 'lucide-react';
import type { FactoryPackSettings } from '../../skills/factory';
import { EmptyNote } from '../../components/EmptyNote';
import { DefinitionGrid, Panel, SectionHeading } from '../document';

type ProjectSettings = FactoryPackSettings['projects'][number];

/** The declaration that could not be read, and overview map keys the pack does not declare. */
export function SettingsErrors({ settings }: { settings: FactoryPackSettings }): ReactNode {
  const declaration = settings.declaration?.error
    ? [{ key: 'declaration', path: settings.declaration.path, text: settings.declaration.error }]
    : [];
  const map = settings.mapErrors.map(text => ({ key: text, path: null, text }));
  const errors = [...declaration, ...map];
  if (errors.length === 0) return null;
  return (
    <Panel
      role="alert"
      tone="var(--error)"
      bar="top"
      className="flex flex-col gap-2 px-5 pt-5 pb-4"
    >
      <p className="text-console-14 font-medium text-error">
        {declaration.length > 0
          ? "The pack's declaration could not be read"
          : 'The factory overview presents a setting the pack does not declare'}
      </p>
      <ul className="flex flex-col gap-1">
        {errors.map(error => (
          <li key={error.key} className="text-console-13 text-text-secondary">
            {error.path === null ? null : (
              <span className="block font-mono [overflow-wrap:anywhere] text-text-primary">
                {error.path}
              </span>
            )}
            <span className="block [overflow-wrap:anywhere]">{error.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * The project whose settings file could not be read: said once, under the band, with
 * the reader's message, which names the file and the reason. Its setting panels then only say "Not read".
 */
export function ProjectUnreadable({ project }: { project: ProjectSettings }): ReactNode {
  if (project.error === null) return null;
  return (
    <Panel
      role="alert"
      tone="var(--error)"
      bar="top"
      className="flex flex-col gap-2 px-5 pt-5 pb-4"
    >
      <p className="text-console-14 font-medium text-error">
        {project.name}&apos;s settings file could not be read, so this page shows none of its values
      </p>
      <p className="text-console-13 text-text-secondary [overflow-wrap:anywhere]">
        {project.error}
      </p>
    </Panel>
  );
}

/** Keys this project's file sets that the pack does not declare; absent when there are none. */
export function Undeclared({ project }: { project: ProjectSettings }): ReactNode {
  const headingId = useId();
  const rows = project.undeclared.map(setting => ({
    key: setting.name,
    label: <span className="font-mono text-text-primary">{setting.name}</span>,
    value: <span className="font-mono [overflow-wrap:anywhere]">{setting.value}</span>,
  }));
  if (rows.length === 0) return null;
  return (
    <section data-doc-section="" aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading
        id={headingId}
        icon={TriangleAlert}
        eyebrow="Refused by a run"
        title="Not declared by the pack"
        tone="var(--warning)"
        count={rows.length}
      />
      <Panel tone="var(--warning)" bar="left" className="flex flex-col gap-3 py-4 pr-4 pl-5">
        <p className="max-w-[80ch] text-console-14 text-text-secondary">
          The project&apos;s settings file sets these, and the pack declares no such setting. A run
          of the pack refuses the file while it does.
        </p>
        <DefinitionGrid rows={rows} />
      </Panel>
    </section>
  );
}

export function NoSettings(): ReactElement {
  return (
    <Panel className="p-5">
      <EmptyNote
        icon={SlidersHorizontal}
        sentence="This pack declares no settings: a project has nothing to set for it."
      />
    </Panel>
  );
}
