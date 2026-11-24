import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router';
import { FileCode, FileText, Info, ListChecks, Workflow } from 'lucide-react';
import { YamlPreview } from '../../builder/components/YamlPreview';
import type { FactoryWorkflow } from '../../skills/factory';
import {
  DefinitionGrid,
  DocumentColumns,
  HeaderBand,
  IdTag,
  Panel,
  SectionHeading,
  StatChip,
  type ToneColor,
} from '../document';
import { stageOfStep } from '../lib/placement';
import { stepPageFromStage, type FactoryStage } from '../lib/stage-steps';
import { coveringCard, modelWords, stepFacts, type StepFact } from '../lib/step-facts';
import { KIND_TONES, KIND_WORDS } from '../lib/step-kinds';
import { referenceLabel, type ReferenceChip } from '../lib/prompt-references';
import { stepLabel } from '../lib/step-label';
import { stageModalLink, type FactoryViewListed } from '../lib/views';
import { CodePanel } from './CodePanel';
import { StepItems, useItemsOnStep } from './StepItems';
import { StepPrompt } from './StepPrompt';
import { StepWorkflowList } from './StepWorkflowList';

type Declaration = FactoryViewListed['declaration'];
type FactoryStep = FactoryWorkflow['steps'][number];

/**
 * A page about one step (owner change 7 of 2026-11-21), on the document pieces: a header band,
 * then the main column (what it does, its prompt or script, the step as written, the items on
 * it now) and an aside (its facts, and its workflow with this step marked).
 */
export function StepDocument({
  projectId,
  view,
  workflow,
  step,
  homeStage,
}: {
  projectId: string;
  view: Declaration;
  workflow: FactoryWorkflow;
  step: FactoryStep;
  /** The stage the page leads back to (`stepHomeStage`), when one runs the workflow. */
  homeStage: FactoryStage | undefined;
}): ReactElement {
  const fromStage = stepPageFromStage(useLocation().state);
  // In sentence case: an undeclared step's name is its cleaned id, which starts lower case.
  const stepName = (key: string): string => {
    const name = stepLabel(view, workflow.name, key);
    return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  };
  const card = coveringCard(view, workflow.name, step.key);
  const chips: ReferenceChip[] = step.references.map(ref => ({
    token: ref.token,
    kind: ref.kind,
    label: referenceLabel(ref, stepName),
  }));
  const tone = KIND_TONES[step.kind];
  const items = useItemsOnStep(projectId, workflow.name, step.key);
  const stage = stageOfStep(view, workflow.name, step.key) ?? homeStage;
  return (
    <div data-doc-page="" className="flex flex-col gap-6">
      <HeaderBand
        title={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {stepName(step.key)}
            <IdTag id={step.key} />
          </span>
        }
        sentence={card?.text ?? `${KIND_WORDS[step.kind]} step of ${workflow.name}.`}
        chips={
          <>
            <StatChip tone={tone} figure={KIND_WORDS[step.kind]} label="step" />
            {step.model === null || step.kind === 'bash' || step.kind === 'script' ? null : (
              <StatChip figure={modelWords(step.model)} label="model" />
            )}
            <StatChip
              figure={<span className="font-mono">{workflow.name}</span>}
              label="workflow"
            />
            {stage === undefined ? null : (
              <StatChip
                figure={
                  <Link
                    to={stageModalLink(projectId, stage.id).to}
                    className="underline decoration-border-bright underline-offset-2 hover:decoration-text-primary"
                  >
                    {stage.label}
                  </Link>
                }
                label="stage"
              />
            )}
            {items.onStep === undefined ? (
              <StatChip figure="…" label="checking what is on this step" />
            ) : (
              <StatChip
                figure={items.onStep.length}
                label="on this step now"
                state={items.onStep.length > 0 ? 'running' : undefined}
              />
            )}
          </>
        }
      />
      <DocumentColumns
        asideLabel="About this step"
        main={
          <>
            {card === undefined ? null : (
              // The covering drill-down card's line, as the header's sentence is: the view file
              // gives one plain-words line per step, and the item asks for it in both places.
              <section data-doc-section="" className="flex flex-col gap-3">
                <SectionHeading icon={Info} eyebrow="What it does" title={card.title} tone={tone} />
                <Panel className="px-5 py-4">
                  <p className="max-w-[80ch] text-console-15 text-text-secondary">{card.text}</p>
                </Panel>
              </section>
            )}
            <StepRuns step={step} tone={tone} stepName={stepName} chips={chips} />
            <StepItems projectId={projectId} view={view} onStep={items.onStep} read={items.read} />
            <StepAsWritten step={step} tone={tone} />
          </>
        }
        aside={
          <>
            <section data-doc-section="" className="flex flex-col gap-3">
              <SectionHeading
                icon={ListChecks}
                eyebrow="Facts"
                title="About this step"
                tone={tone}
              />
              <Panel className="px-4 py-4">
                <DefinitionGrid
                  rows={stepFacts({
                    step,
                    view,
                    workflow: workflow.name,
                    steps: workflow.steps,
                    groups: workflow.groups,
                    stepName,
                  }).map(fact => ({
                    key: fact.key,
                    label: fact.label,
                    value: <FactValue fact={fact} />,
                  }))}
                />
              </Panel>
            </section>
            <section data-doc-section="" className="flex flex-col gap-3">
              <SectionHeading
                icon={Workflow}
                eyebrow={workflow.name}
                title="Its workflow"
                tone={tone}
                count={workflow.steps.length}
              />
              <StepWorkflowList
                projectId={projectId}
                workflow={workflow}
                current={step.key}
                stepName={stepName}
                fromStage={fromStage}
              />
            </section>
          </>
        }
      />
    </div>
  );
}

/** A fact's value: one text, one line each, short chips, or outcomes with their ids. */
function FactValue({ fact }: { fact: StepFact }): ReactElement {
  if (fact.outcomes !== undefined)
    return (
      <ul className="flex flex-col gap-0.5">
        {fact.outcomes.map(outcome => (
          <li key={outcome.id} className="flex flex-wrap items-baseline gap-x-2">
            {outcome.words}
            <IdTag id={outcome.id} />
          </li>
        ))}
      </ul>
    );
  if (fact.chips !== undefined)
    return (
      <ul className="flex flex-wrap gap-1.5">
        {fact.chips.map(chip => (
          <li
            key={chip}
            className="rounded-full bg-surface-inset px-2 text-console-13 text-text-primary ring-1 ring-inset ring-border"
          >
            {chip}
          </li>
        ))}
      </ul>
    );
  if (fact.lines !== undefined)
    return (
      <ul className="flex flex-col gap-0.5">
        {fact.lines.map(line => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  return (
    <span title={fact.title} className={fact.mono === true ? 'font-mono text-console-13' : ''}>
      {fact.text}
    </span>
  );
}

/** What the step runs: its prompt, as a document, or its script, on a code panel. */
function StepRuns({
  step,
  tone,
  stepName,
  chips,
}: {
  step: FactoryStep;
  tone: ToneColor;
  stepName: (key: string) => string;
  chips: readonly ReferenceChip[];
}): ReactElement | null {
  const runsCode = step.kind === 'bash' || step.kind === 'script';
  if (runsCode)
    return (
      <section data-doc-section="" className="flex flex-col gap-3">
        <SectionHeading
          icon={FileCode}
          eyebrow="The script"
          title={
            step.script?.name != null
              ? `Runs the script ${step.script.name}`
              : step.kind === 'bash'
                ? 'The shell command it runs'
                : 'The script it runs'
          }
          tone={tone}
        />
        {step.script === null ? (
          <ErrorPanel text={step.scriptError ?? 'This step names no script.'} />
        ) : (
          <CodePanel code={step.script.body} label={`The script of ${stepName(step.key)}`} />
        )}
      </section>
    );
  if (step.prompt === null && step.promptError === null) return null;
  return (
    <section data-doc-section="" className="flex flex-col gap-3">
      <SectionHeading
        icon={FileText}
        eyebrow="The prompt"
        title={step.command === null ? 'Written in the workflow' : `From command ${step.command}`}
        tone={tone}
      />
      {step.prompt === null ? (
        <ErrorPanel text={step.promptError ?? ''} />
      ) : (
        <StepPrompt prompt={step.prompt} chips={chips} />
      )}
    </section>
  );
}

function ErrorPanel({ text }: { text: string }): ReactElement {
  return (
    <Panel className="px-5 py-4">
      <p className="font-mono text-console-13 text-error [overflow-wrap:anywhere]">{text}</p>
    </Panel>
  );
}

/**
 * The step's block as its author wrote it, folded: the route table still lists it, and the page
 * above says the same in words.
 */
function StepAsWritten({ step, tone }: { step: FactoryStep; tone: ToneColor }): ReactElement {
  return (
    <section data-doc-section="" className="flex flex-col gap-3">
      <SectionHeading icon={FileCode} eyebrow="YAML" title="The step as written" tone={tone} />
      <Panel>
        <details>
          <summary className="cursor-pointer px-5 py-3 text-console-13 text-text-secondary hover:text-text-primary">
            Show the YAML
          </summary>
          {step.yaml === null ? (
            <p className="px-5 pb-4 text-console-13 text-text-secondary">{step.yamlError}</p>
          ) : (
            // The whole block, at its own height, with long lines wrapped: a block runs to a
            // hundred lines, and a sideways scrollbar under the last one is out of sight.
            <div className="border-t border-border bg-surface-inset [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words">
              <YamlPreview yamlText={step.yaml} />
            </div>
          )}
        </details>
      </Panel>
    </section>
  );
}
