import type {
  IsolationEnvironmentRow,
  CreateEnvironmentParams,
  IsolationWorkflowType,
} from './types';

export interface IIsolationStore {
  getById(id: string): Promise<IsolationEnvironmentRow | null>;
  findActiveByWorkflow(
    codebaseId: string,
    workflowType: IsolationWorkflowType,
    workflowId: string
  ): Promise<IsolationEnvironmentRow | null>;
  create(env: CreateEnvironmentParams): Promise<IsolationEnvironmentRow>;
  updateStatus(id: string, status: 'active' | 'destroyed'): Promise<void>;
  countActiveByCodebase(codebaseId: string): Promise<number>;
}
