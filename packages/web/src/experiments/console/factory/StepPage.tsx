import type { ReactElement, ReactNode } from 'react';
import { FileQuestionMark } from 'lucide-react';
import { Link, useLocation, useParams } from 'react-router';
import { EmptyNote } from '../components/EmptyNote';
import { HttpError } from '../lib/http';
import { BackLink } from './BackLink';
import { FactoryFrame } from './FactoryFrame';
import { WAY_ON_LINK } from './FactoryNotFound';
import {
  stagesOfWorkflow,
  stepInStage,
  stepPageFromStage,
  type FactoryStage,
} from './lib/stage-steps';
import { factoryPath, stageModalLink, type FactoryViewListed } from './lib/views';
import { FactoryLoading } from './FactoryLoading';
import { GraphSkeleton } from './GraphSkeleton';
import { StepDocument } from './step/StepDocument';
import { useFactoryWorkflow, WorkflowReadFailure } from './stage/useFactoryWorkflow';

type Declaration = FactoryViewListed['declaration'];

/** `/console/p/:projectId/factory/steps/:workflow/:node`: what one step runs, and on what. */
export function StepPage(): ReactElement {
  const {
    projectId = '',
    workflow = '',
    node = '',
  } = useParams<{ projectId: string; workflow: string; node: string }>();
  return (
    <FactoryFrame section={null} wide>
      {view => (
        <div className="flex flex-col gap-6">
          <StepBackLink
            projectId={projectId}
            stages={stagesOfWorkflow(view.declaration.stages, workflow)}
            stepKey={node}
          />
          <StepBody
            projectId={projectId}
            view={view.declaration}
            workflow={workflow}
            stepKey={node}
          />
        </div>
      )}
    </FactoryFrame>
  );
}

/**
 * The stage a step page leads back to: the stage it was opened from, else the stage that works
 * this step, else the first naming its workflow; undefined when no stage runs the workflow.
 */
function stepHomeStage(
  stages: FactoryStage[],
  fromStage: string | undefined,
  stepKey: string
): FactoryStage | undefined {
  return (
    stages.find(candidate => candidate.id === fromStage) ??
    stages.find(candidate => stepInStage(candidate, stepKey)) ??
    stages[0]
  );
}

/** Back to the step's home stage (`stepHomeStage`), open over the Overview; else the overview. */
function StepBackLink({
  projectId,
  stages,
  stepKey,
}: {
  projectId: string;
  stages: FactoryStage[];
  stepKey: string;
}): ReactElement {
  const stage = stepHomeStage(stages, stepPageFromStage(useLocation().state), stepKey);
  if (stage === undefined)
    return <BackLink to={factoryPath(projectId)} label="Back to the overview" />;
  // The stage's home is its modal over the Overview. No `stageModal` state: closing it then
  // drops `?stage=` in place, rather than going back to this step page.
  return <BackLink to={stageModalLink(projectId, stage.id).to} label={`Back to ${stage.label}`} />;
}

/**
 * A step or workflow this factory does not have, in plain words, with the way on: the step's
 * home stage, else the Overview.
 */
function StepNotFound({
  projectId,
  stages,
  stepKey,
  sentence,
}: {
  projectId: string;
  stages: FactoryStage[];
  stepKey: string;
  sentence: ReactNode;
}): ReactElement {
  const stage = stepHomeStage(stages, stepPageFromStage(useLocation().state), stepKey);
  return (
    <EmptyNote
      icon={FileQuestionMark}
      sentence={sentence}
      link={
        stage === undefined ? (
          <Link to={factoryPath(projectId)} className={WAY_ON_LINK}>
            Open the Overview
          </Link>
        ) : (
          <Link to={stageModalLink(projectId, stage.id).to} className={WAY_ON_LINK}>
            Open {stage.label}
          </Link>
        )
      }
    />
  );
}

/**
 * The workflow read answered that no stage of this factory runs `workflow`. The route answers
 * 404 for that and for a stage's workflow its pack does not provide here (its words say why and
 * what to do), so only a workflow no declared stage names is not found; the other stays a
 * failure to show. The step page renders inside `FactoryFrame` once the project's view has loaded, so the
 * route's 404 for an unknown project does not reach here.
 */
function isNoSuchWorkflow(error: Error, stages: FactoryStage[]): boolean {
  return error instanceof HttpError && error.status === 404 && stages.length === 0;
}

function StepBody({
  projectId,
  view,
  workflow,
  stepKey,
}: {
  projectId: string;
  view: Declaration;
  workflow: string;
  stepKey: string;
}): ReactElement {
  const { read, failed, retry } = useFactoryWorkflow(projectId, workflow);
  const stages = stagesOfWorkflow(view.stages, workflow);
  const fromStage = stepPageFromStage(useLocation().state);
  if (read.data === undefined) {
    if (failed === undefined)
      return (
        <FactoryLoading read={read}>
          <GraphSkeleton label="Loading the step" />
        </FactoryLoading>
      );
    if (isNoSuchWorkflow(failed, stages))
      return (
        <StepNotFound
          projectId={projectId}
          stages={stages}
          stepKey={stepKey}
          sentence={
            <>
              There is no workflow <span className="font-mono">{workflow}</span> in this factory.
            </>
          }
        />
      );
    return <WorkflowReadFailure workflow={workflow} error={failed} retry={retry} />;
  }
  const step = read.data.steps.find(candidate => candidate.key === stepKey);
  if (step === undefined)
    return (
      <StepNotFound
        projectId={projectId}
        stages={stages}
        stepKey={stepKey}
        sentence={
          <>
            There is no step <span className="font-mono">{stepKey}</span> in{' '}
            <span className="font-mono">{workflow}</span>.
          </>
        }
      />
    );
  return (
    <StepDocument
      projectId={projectId}
      view={view}
      workflow={read.data}
      step={step}
      homeStage={stepHomeStage(stages, fromStage, stepKey)}
    />
  );
}
