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
  
  // Backend Services
  llm_primary: {
    id: 'llm_primary',
    name: 'Primary LLM',
    icon: '🧠',
    description: 'Main language model for general tasks',
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
    icon: '🔄',
    description: 'Fallback model for simpler tasks',
    category: 'service',
    supportsTemperature: true,
    supportsMaxTokens: true,
    defaultModel: 'openai:gpt-4o-mini',
    modelType: 'llm',
    costProfile: 'medium'
  },
  embedding: {
    id: 'embedding',
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
  }
};

// Helper to get agents only
export const getAgents = () => 
  Object.values(AGENT_CONFIGS).filter(c => c.category === 'agent');

// Helper to get services only  
export const getServices = () =>
  Object.values(AGENT_CONFIGS).filter(c => c.category === 'service');