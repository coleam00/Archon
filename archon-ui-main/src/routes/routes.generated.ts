/**
 * Auto-generated API route definitions
 * DO NOT EDIT MANUALLY - This file is generated from Python route definitions
 * 
 * Generated at: 2025-08-25T11:07:46.697050
 */

/**
 * Type-safe API route builders
 * Each function returns a properly formatted API path with parameters
 */
export const API_ROUTES = {
  agentchat: {
    create_session: (): string => '/api/agent-chat/sessions',
    get_session: (session_id: string): string => `/api/agent-chat/sessions/${session_id}`,
    list_sessions: (): string => '/api/agent-chat/sessions',
    status: (): string => '/api/agent-chat/status',
    update_session: (session_id: string): string => `/api/agent-chat/sessions/${session_id}`
  },
  bugreport: {
    submit_github: (): string => '/api/bug-report/github'
  },
  coverage: {
    debug_paths: (): string => '/api/coverage/debug/paths',
    pytest_html: (): string => '/api/coverage/pytest/html/{path:path}',
    pytest_json: (): string => '/api/coverage/pytest/json'
  },
  health: {
    api_health: (): string => '/api/health',
    health: (): string => '/health',
    root: (): string => '/'
  },
  internal: {
    credentials_agents: (): string => '/internal/credentials/agents',
    credentials_mcp: (): string => '/internal/credentials/mcp',
    health: (): string => '/internal/health'
  },
  knowledge: {
    crawl_deep: (): string => '/api/crawl/deep',
    crawl_single: (): string => '/api/crawl/single',
    crawl_smart: (): string => '/api/crawl/smart',
    crawl_status: (): string => '/api/crawl/status',
    delete_item: (item_id: string): string => `/api/knowledge/items/${item_id}`,
    get_sources: (): string => '/api/sources',
    list_items: (): string => '/api/knowledge/items',
    rag_query: (): string => '/api/rag',
    search: (): string => '/api/knowledge/search',
    upload_file: (): string => '/api/upload'
  },
  mcp: {
    config: (): string => '/api/mcp/config',
    delete_logs: (): string => '/api/mcp/logs',
    health: (): string => '/api/mcp/health',
    logs: (): string => '/api/mcp/logs',
    start: (): string => '/api/mcp/start',
    status: (): string => '/api/mcp/status',
    stop: (): string => '/api/mcp/stop',
    tools: (): string => '/api/mcp/tools',
    update_config: (): string => '/api/mcp/config'
  },
  projects: {
    create: (): string => '/api/projects',
    create_document: (project_id: string): string => `/api/projects/${project_id}/documents`,
    create_task: (project_id: string): string => `/api/projects/${project_id}/tasks`,
    delete: (project_id: string): string => `/api/projects/${project_id}`,
    delete_task: (project_id: string, task_id: string): string => `/api/projects/${project_id}/tasks/${task_id}`,
    delete_task_direct: (task_id: string): string => `/api/tasks/${task_id}`,
    detail: (project_id: string): string => `/api/projects/${project_id}`,
    list: (): string => '/api/projects',
    list_documents: (project_id: string): string => `/api/projects/${project_id}/documents`,
    list_tasks: (project_id: string): string => `/api/projects/${project_id}/tasks`,
    project_features: (project_id: string): string => `/api/project-features/${project_id}`,
    tasks_by_status: (): string => '/api/tasks',
    task_detail: (task_id: string): string => `/api/tasks/${task_id}`,
    update: (project_id: string): string => `/api/projects/${project_id}`,
    update_document: (project_id: string, document_id: string): string => `/api/projects/${project_id}/documents/${document_id}`,
    update_task: (project_id: string, task_id: string): string => `/api/projects/${project_id}/tasks/${task_id}`,
    update_task_status: (task_id: string): string => `/api/tasks/${task_id}`
  },
  providers: {
    add_credential: (provider_id: string): string => `/api/providers/${provider_id}/credentials`,
    add_model: (provider_id: string): string => `/api/providers/${provider_id}/models`,
    chat: (): string => '/api/providers/chat',
    create: (): string => '/api/providers',
    create_incident: (provider_id: string): string => `/api/providers/${provider_id}/incidents`,
    create_quota: (provider_id: string): string => `/api/providers/${provider_id}/quotas`,
    delete: (provider_id: string): string => `/api/providers/${provider_id}`,
    detail: (provider_id: string): string => `/api/providers/${provider_id}`,
    embeddings: (): string => '/api/providers/embeddings',
    get_active: (): string => '/api/providers/active',
    get_usage: (provider_id: string): string => `/api/providers/${provider_id}/usage`,
    health_check: (provider_id: string): string => `/api/providers/${provider_id}/health-check`,
    health_history: (provider_id: string): string => `/api/providers/${provider_id}/health-history`,
    list: (): string => '/api/providers',
    list_incidents: (provider_id: string): string => `/api/providers/${provider_id}/incidents`,
    list_models: (): string => '/api/providers/models/',
    list_quotas: (provider_id: string): string => `/api/providers/${provider_id}/quotas`,
    rotate_credential: (credential_id: string): string => `/api/providers/credentials/${credential_id}/rotate`,
    set_active: (): string => '/api/providers/active',
    update: (provider_id: string): string => `/api/providers/${provider_id}`,
    update_incident: (incident_id: string): string => `/api/providers/incidents/${incident_id}`,
    usage_summary: (): string => '/api/providers/usage/summary'
  },
  settings: {
    create_credential: (): string => '/api/credentials',
    database_metrics: (): string => '/api/database/metrics',
    delete_credential: (key: string): string => `/api/credentials/${key}`,
    get_category_credentials: (category: string): string => `/api/credentials/categories/${category}`,
    get_credential: (key: string): string => `/api/credentials/${key}`,
    initialize_credentials: (): string => '/api/credentials/initialize',
    list_credentials: (): string => '/api/credentials',
    settings_health: (): string => '/api/settings/health',
    update_credential: (key: string): string => `/api/credentials/${key}`
  },
  tests: {
    delete_execution: (execution_id: string): string => `/api/tests/execution/${execution_id}`,
    history: (): string => '/api/tests/history',
    latest_results: (): string => '/api/tests/latest-results',
    run_mcp: (): string => '/api/tests/mcp/run',
    run_ui: (): string => '/api/tests/ui/run',
    status: (execution_id: string): string => `/api/tests/status/${execution_id}`
  }
} as const;

/**
 * Type definitions for route parameters
 */
export interface AgentchatGetSessionParams {
  session_id: string;
}

export interface AgentchatUpdateSessionParams {
  session_id: string;
}

export interface KnowledgeDeleteItemParams {
  item_id: string;
}

export interface ProjectsCreateDocumentParams {
  project_id: string;
}

export interface ProjectsCreateTaskParams {
  project_id: string;
}

export interface ProjectsDeleteParams {
  project_id: string;
}

export interface ProjectsDeleteTaskParams {
  project_id: string;
  task_id: string;
}

export interface ProjectsDeleteTaskDirectParams {
  task_id: string;
}

export interface ProjectsDetailParams {
  project_id: string;
}

export interface ProjectsListDocumentsParams {
  project_id: string;
}

export interface ProjectsListTasksParams {
  project_id: string;
}

export interface ProjectsProjectFeaturesParams {
  project_id: string;
}

export interface ProjectsTaskDetailParams {
  task_id: string;
}

export interface ProjectsUpdateParams {
  project_id: string;
}

export interface ProjectsUpdateDocumentParams {
  project_id: string;
  document_id: string;
}

export interface ProjectsUpdateTaskParams {
  project_id: string;
  task_id: string;
}

export interface ProjectsUpdateTaskStatusParams {
  task_id: string;
}

export interface ProvidersAddCredentialParams {
  provider_id: string;
}

export interface ProvidersAddModelParams {
  provider_id: string;
}

export interface ProvidersCreateIncidentParams {
  provider_id: string;
}

export interface ProvidersCreateQuotaParams {
  provider_id: string;
}

export interface ProvidersDeleteParams {
  provider_id: string;
}

export interface ProvidersDetailParams {
  provider_id: string;
}

export interface ProvidersGetUsageParams {
  provider_id: string;
}

export interface ProvidersHealthCheckParams {
  provider_id: string;
}

export interface ProvidersHealthHistoryParams {
  provider_id: string;
}

export interface ProvidersListIncidentsParams {
  provider_id: string;
}

export interface ProvidersListQuotasParams {
  provider_id: string;
}

export interface ProvidersRotateCredentialParams {
  credential_id: string;
}

export interface ProvidersUpdateParams {
  provider_id: string;
}

export interface ProvidersUpdateIncidentParams {
  incident_id: string;
}

export interface SettingsDeleteCredentialParams {
  key: string;
}

export interface SettingsGetCategoryCredentialsParams {
  category: string;
}

export interface SettingsGetCredentialParams {
  key: string;
}

export interface SettingsUpdateCredentialParams {
  key: string;
}

export interface TestsDeleteExecutionParams {
  execution_id: string;
}

export interface TestsStatusParams {
  execution_id: string;
}

/**
 * Helper type to extract route paths
 */
export type ApiRoutePath = string;

/**
 * Type-safe route builder function
 */
export type RouteBuilder<T extends any[] = []> = (...args: T) => string;

/**
 * Extract all API routes for validation
 */
export const ALL_ROUTES: string[] = [
  '/api/agent-chat/sessions',
  '/api/agent-chat/sessions',
  '/api/agent-chat/status',
  '/api/bug-report/github',
  '/api/coverage/debug/paths',
  '/api/coverage/pytest/html/{path:path}',
  '/api/coverage/pytest/json',
  '/api/health',
  '/health',
  '/',
  '/internal/credentials/agents',
  '/internal/credentials/mcp',
  '/internal/health',
  '/api/crawl/deep',
  '/api/crawl/single',
  '/api/crawl/smart',
  '/api/crawl/status',
  '/api/sources',
  '/api/knowledge/items',
  '/api/rag',
  '/api/knowledge/search',
  '/api/upload',
  '/api/mcp/config',
  '/api/mcp/logs',
  '/api/mcp/health',
  '/api/mcp/logs',
  '/api/mcp/start',
  '/api/mcp/status',
  '/api/mcp/stop',
  '/api/mcp/tools',
  '/api/mcp/config',
  '/api/projects',
  '/api/projects',
  '/api/tasks',
  '/api/providers/chat',
  '/api/providers',
  '/api/providers/embeddings',
  '/api/providers/active',
  '/api/providers',
  '/api/providers/models/',
  '/api/providers/active',
  '/api/providers/usage/summary',
  '/api/credentials',
  '/api/database/metrics',
  '/api/credentials/initialize',
  '/api/credentials',
  '/api/settings/health',
  '/api/tests/history',
  '/api/tests/latest-results',
  '/api/tests/mcp/run',
  '/api/tests/ui/run'
];
