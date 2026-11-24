import type { Thread } from '../codex/protocol/v2/Thread';
import type { ThreadStartResponse } from '../codex/protocol/v2/ThreadStartResponse';
import type { ThreadResumeResponse } from '../codex/protocol/v2/ThreadResumeResponse';
import type { ThreadForkResponse } from '../codex/protocol/v2/ThreadForkResponse';

function threadOf(id: string): Thread {
  return {
    id,
    sessionId: id,
    environments: null,
    extra: null,
    canAcceptDirectInput: null,
    daybreakEnabled: null,
    forkedFromId: null,
    parentThreadId: null,
    attachedToThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model: null,
    reasoningEffort: null,
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd: '/workspace',
    cliVersion: '0.0.0',
    originator: null,
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

export function threadStartResponse(id: string): ThreadStartResponse {
  return {
    thread: threadOf(id),
    model: 'gpt-fake',
    runtimeWorkspaceRoots: [],
    activePermissionProfile: null,
    multiAgentMode: 'explicitRequestOnly',
    modelProvider: 'openai',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: '/workspace',
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: null,
  };
}

export function threadResumeResponse(id: string): ThreadResumeResponse {
  return {
    ...threadStartResponse(id),
    collaborationMode: null,
    initialTurnsPage: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

export function threadForkResponse(id: string, source: string): ThreadForkResponse {
  const response = threadStartResponse(id);
  return { ...response, thread: { ...response.thread, forkedFromId: source } };
}
