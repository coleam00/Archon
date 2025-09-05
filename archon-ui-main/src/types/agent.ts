/**
 * Agent Configuration Types
 * 
 * Types for agent-centric provider configuration
 */

export interface AgentConfig {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: 'agent' | 'service';
  supportsTemperature?: boolean;
  supportsMaxTokens?: boolean;
  defaultModel: string;
  modelType: 'llm' | 'embedding';
  costProfile: 'high' | 'medium' | 'low';
}

export interface AgentModelConfig {
  agent_id: string;
  model_string: string;
  temperature?: number;
  max_tokens?: number;
  enabled: boolean;
}

export interface AgentUsageStats {
  agent_id: string;
  agent_name: string;
  total_requests: number;
  total_cost: number;
  avg_response_time_ms: number;
  last_used?: string;
}

// Agent configuration registry
export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  // PydanticAI Agents
  document_agent: {
    id: 'document_agent',
    name: 'Document Agent',
    icon: '📄',
    description: 'Creates and manages project documents (PRDs, specs, notes)',
    category: 'agent',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o',
    modelType: 'llm',
    costProfile: 'high'
  },
  rag_agent: {
    id: 'rag_agent',
    name: 'RAG Agent',
    icon: '🔍',
    description: 'Searches and chats with your knowledge base',
    category: 'agent',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o-mini',
    modelType: 'llm',
    costProfile: 'medium'
  },
  task_agent: {
    id: 'task_agent',
    name: 'Task Agent',
    icon: '📋',
    description: 'Creates and manages project tasks with AI assistance',
    category: 'agent',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o',
    modelType: 'llm',
    costProfile: 'high'
  },
  
  // Backend Services
  embeddings: {
    id: 'embeddings',
    name: 'Embedding Service',
    icon: '🧩',
    description: 'Converts documents to searchable vectors',
    category: 'service',
    supportsTemperature: false,
    supportsMaxTokens: false,
    defaultModel: 'openai:text-embedding-3-small',
    modelType: 'embedding',
    costProfile: 'low'
  },
  contextual_embedding: {
    id: 'contextual_embedding',
    name: 'Contextual Embeddings',
    icon: '🎯',
    description: 'Generates context-aware embeddings for better search',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: false,
    defaultModel: 'openai:gpt-4o-mini',
    modelType: 'llm',
    costProfile: 'medium'
  },
  source_summary: {
    id: 'source_summary',
    name: 'Summary Generation',
    icon: '📝',
    description: 'Creates summaries for documents and sources',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o-mini',
    modelType: 'llm',
    costProfile: 'medium'
  },
  code_summary: {
    id: 'code_summary',
    name: 'Code Summaries',
    icon: '🔧',
    description: 'Generates descriptions for code examples',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: false,
    defaultModel: 'openai:gpt-4o-mini',
    modelType: 'llm',
    costProfile: 'medium'
  },
  code_analysis: {
    id: 'code_analysis',
    name: 'Code Analysis',
    icon: '💻',
    description: 'Understands and generates code',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'anthropic:claude-3-haiku-20240307',
    modelType: 'llm',
    costProfile: 'medium'
  },
  validation: {
    id: 'validation',
    name: 'Validation Service',
    icon: '✅',
    description: 'Validates data and verifies outputs',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: false,
    defaultModel: 'openai:gpt-3.5-turbo',
    modelType: 'llm',
    costProfile: 'low'
  },

  // Additional backend services
  llm_primary: {
    id: 'llm_primary',
    name: 'Primary LLM',
    icon: '🧠',
    description: 'Primary language model for general tasks',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o',
    modelType: 'llm',
    costProfile: 'high'
  },
  llm_secondary: {
    id: 'llm_secondary',
    name: 'Secondary LLM',
    icon: '🤖',
    description: 'Secondary language model for backup tasks',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o-mini',
    modelType: 'llm',
    costProfile: 'medium'
  },
  embedding: {
    id: 'embedding',
    name: 'Legacy Embedding',
    icon: '📐',
    description: 'Legacy embedding service',
    category: 'service',
    supportsTemperature: false,
    supportsMaxTokens: false,
    defaultModel: 'openai:text-embedding-ada-002',
    modelType: 'embedding',
    costProfile: 'low'
  },
  summary_generation: {
    id: 'summary_generation',
    name: 'Summary Generator',
    icon: '📝',
    description: 'Generates summaries and abstracts',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o-mini',
    modelType: 'llm',
    costProfile: 'medium'
  },
  chat_agent: {
    id: 'chat_agent',
    name: 'Chat Agent',
    icon: '💬',
    description: 'Interactive chat and conversation agent',
    category: 'agent',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o',
    modelType: 'llm',
    costProfile: 'high'
  },
  code_agent: {
    id: 'code_agent',
    name: 'Code Agent',
    icon: '👨‍💻',
    description: 'Specialized agent for code generation and analysis',
    category: 'agent',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'anthropic:claude-3-5-sonnet-20241022',
    modelType: 'llm',
    costProfile: 'high'
  },
  vision_agent: {
    id: 'vision_agent',
    name: 'Vision Agent',
    icon: '👁️',
    description: 'Processes and understands visual content',
    category: 'agent',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o',
    modelType: 'llm',
    costProfile: 'high'
  }
};

// =====================================================
// LEGACY HELPER FUNCTIONS - DEPRECATED
// =====================================================
// These functions are deprecated. Use useServiceRegistry() hook instead:
// - useServiceRegistry().agents (replaces getAgents())
// - useServiceRegistry().backendServices (replaces getServices())

/**
 * @deprecated Use useServiceRegistry().agents instead
 */
export const getAgents = () => {
  console.warn('getAgents() is deprecated. Use useServiceRegistry().agents instead.');
  return [];
};

/**
 * @deprecated Use useServiceRegistry().backendServices instead
 */
export const getServices = () => {
  console.warn('getServices() is deprecated. Use useServiceRegistry().backendServices instead.');
  return [];
};