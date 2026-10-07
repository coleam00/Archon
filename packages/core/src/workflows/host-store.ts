import type { RunDoorbell } from '../services/run-attention-watch';
import type { IIsolationStore, IsolationEnvironmentRow } from '@archon/isolation';
import type { Codebase, CreateCodebaseInput, UpdateCodebaseInput } from '../schemas/codebase';
import type { User, IdentityPlatform } from '../schemas/user';
import type { Conversation, UpdateConversationInput } from '../schemas/conversation';
import type { MessageRow } from '../schemas/message';
import type { IWorkflowEngine } from '@archon/workflows/engine-port';
import type { WorkflowOperations } from '../operations/workflow-operations';
import type { createWorkflowDeps } from './store-adapter';

export interface IWorkflowHostStore {
  codebases: {
    getCodebase(id: string): Promise<Codebase | null>;
    findCodebaseByDefaultCwd(cwd: string): Promise<Codebase | null>;
    findCodebaseByPathPrefix(cwd: string): Promise<Codebase | null>;
    findCodebaseByName(name: string): Promise<Codebase | null>;
    findCodebaseByRepoUrl(url: string): Promise<Codebase | null>;
    listCodebases(): Promise<readonly Codebase[]>;
    createCodebase(data: CreateCodebaseInput): Promise<Codebase>;
    updateCodebase(target: Pick<Codebase, 'id' | 'name'>, data: UpdateCodebaseInput): Promise<void>;
    getCodebaseCommands(id: string): Promise<Codebase['commands']>;
    updateCodebaseCommands(id: string, commands: Codebase['commands']): Promise<void>;
  };
  users: {
    getUserById(id: string): Promise<User | null>;
    findOrCreateUserByPlatformIdentity(
      platform: IdentityPlatform,
      id: string,
      displayName?: string
    ): Promise<User>;
  };
  conversations: {
    getConversationById(id: string): Promise<Conversation | null>;
    updateConversation(id: string, updates: UpdateConversationInput): Promise<void>;
  };
  messages: {
    addMessage(
      conversationId: string,
      role: MessageRow['role'],
      content: string,
      metadata?: Record<string, unknown>,
      userId?: string
    ): Promise<MessageRow>;
  };
  isolation: IIsolationStore & {
    listByCodebase(codebaseId: string): Promise<readonly IsolationEnvironmentRow[]>;
    findLatestByCodebaseAndWorkingPath(
      codebaseId: string,
      workingPath: string,
      createdBefore: Date
    ): Promise<IsolationEnvironmentRow | null>;
  };
}

/** One workflow host: the engine, operations, queries and termination share `deps.store`. */
export interface WorkflowHost {
  deps: ReturnType<typeof createWorkflowDeps>;
  records: IWorkflowHostStore;
  engine: IWorkflowEngine;
  operations: WorkflowOperations;
  doorbell?: RunDoorbell;
}
