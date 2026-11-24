import type { CSSProperties, ReactElement } from 'react';
import { Link, useLocation } from 'react-router';
import type { LaidOutStep } from './lib/step-graph-layout';
import { stageSwitchLink } from './lib/views';
import { toneColor } from './tones';

/** Half a tag's height, so it sits across its step's top border. */
const TAG_HALF_H = 9;
/** How far in from its step's right edge a tag ends. */
const TAG_INSET = 8;

/**
 * Who works each step, as a small tag across the step's top-right border: "This stage" on the
 * open stage's own steps, and on another stage's step that stage's name, which opens it on its
 * real workflow. Drawn beside the step buttons, not in them: a link cannot sit in a button. A
 * step no stage of the view names carries none.
 */
export function StepTags({
  projectId,
  steps,
}: {
  projectId: string;
  steps: readonly LaidOutStep[];
}): ReactElement {
  const location = useLocation();
  return (
    <>
      {steps.map(step => {
        const { worker } = step.node;
        if (worker.kind === 'none') return null;
        const style: CSSProperties = {
          left: step.x + step.width - TAG_INSET,
          top: step.y - TAG_HALF_H,
          borderColor: toneColor(worker.stage.group),
        };
        const className =
          'absolute -translate-x-full whitespace-nowrap rounded border bg-surface px-1 text-console-12 leading-4';
        if (worker.kind === 'this')
          return (
            <span
              key={step.node.key}
              data-step-tag="this"
              className={`${className} text-text-primary`}
              style={style}
            >
              This stage
            </span>
          );
        const link = stageSwitchLink(projectId, worker.stage.id, location);
        return (
          <Link
            key={step.node.key}
            data-step-tag={worker.stage.id}
            to={link.to}
            replace={link.replace}
            state={link.state}
            title={`Open ${worker.stage.label}`}
            className={`${className} text-text-secondary hover:text-text-primary hover:underline`}
            style={style}
          >
            {worker.stage.label}
          </Link>
        );
      })}
    </>
  );
}
