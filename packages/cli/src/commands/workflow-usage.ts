import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { RunUsageReport } from '@archon/workflows/schemas/run-usage-report';
import { unknownRunUsageReport } from '@archon/workflows/run-usage-report';
import { formatUsageReport } from '@archon/workflows/run-usage-format';

export function formatRunUsage(
  metadata: WorkflowRun['metadata'],
  report?: RunUsageReport
): string[] {
  return formatUsageReport(
    report ?? unknownRunUsageReport({ id: '(unavailable)', metadata }, 'history_unavailable')
  );
}
