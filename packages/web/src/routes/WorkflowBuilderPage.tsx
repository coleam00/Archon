import { WorkflowBuilder } from '@/components/workflows/WorkflowBuilder';

export function WorkflowBuilderPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <WorkflowBuilder />
    </div>
  );
}
