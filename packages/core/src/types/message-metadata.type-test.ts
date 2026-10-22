import type { MessageMetadata } from '@archon/core/types';
import type {} from '@archon/workflows/deps';

declare module '@archon/workflows/deps' {
  interface WorkflowMessageMetadata {
    futureField?: string;
  }
}

export const workflowOwnedField = { futureField: 'trace-id' } satisfies MessageMetadata;
