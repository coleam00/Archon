import type { ReactElement } from 'react';
import * as skill from '../../skills';
import type { FactoryWorkflow } from '../../skills/factory';
import type { EntityView } from '../../store/cache';
import { K } from '../../store/keys';
import { retryOnceOnNetworkFailure } from '../lib/network-retry';
import { readFailure } from '../lib/read-failure';
import { ReadFailure } from '../ReadFailure';
import { useFactoryRead } from '../useFactoryRead';
import { useReadRetry, type ReadRetry } from '../useReadRetry';

/** A workflow's steps as the stage graph and the step page read them, and what to show if it failed. */
interface WorkflowRead extends ReadRetry {
  read: EntityView<FactoryWorkflow>;
}

/**
 * The one reader of a workflow's steps (`/api/factory/workflow`), shared by the stage's graph and
 * the step page, so the cache key has one loader. A network failure is tried once more, and a
 * failure is shown with a Retry (`WorkflowReadFailure`) that visibly retries (`useReadRetry`).
 */
export function useFactoryWorkflow(projectId: string, workflow: string): WorkflowRead {
  const read = useFactoryRead<FactoryWorkflow>(K.factoryWorkflow(projectId, workflow), within =>
    retryOnceOnNetworkFailure(() =>
      within(signal => skill.getFactoryWorkflow({ codebaseId: projectId, workflow }, { signal }))
    )
  );
  return { read, ...useReadRetry(read) };
}

/** What failed reading `workflow`, and a Retry; whatever else the page drew stays drawn. */
export function WorkflowReadFailure({
  workflow,
  error,
  retry,
}: {
  workflow: string;
  error: Error;
  retry: () => void;
}): ReactElement {
  return (
    <ReadFailure retry={retry}>
      Could not read the workflow <span className="font-mono">{workflow}</span>:{' '}
      {readFailure(error)}
    </ReadFailure>
  );
}
