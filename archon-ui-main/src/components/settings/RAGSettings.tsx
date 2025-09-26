import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Check, Save, Loader, ChevronDown, ChevronUp, Zap, Database, Trash2, Cog } from 'lucide-react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Button as GlowButton } from '../../features/ui/primitives/button';
import { LuBrainCircuit } from 'react-icons/lu';
import { PiDatabaseThin } from 'react-icons/pi';
import { useToast } from '../../features/shared/hooks/useToast';
import { credentialsService } from '../../services/credentialsService';
import OllamaModelDiscoveryModal from './OllamaModelDiscoveryModal';
import OllamaModelSelectionModal from './OllamaModelSelectionModal';

type ProviderKey = 'openai' | 'google' | 'ollama' | 'anthropic' | 'grok' | 'openrouter';

// Providers that support embedding models
const EMBEDDING_CAPABLE_PROVIDERS: ProviderKey[] = ['openai', 'google', 'ollama'];

interface ProviderModels {
  chatModel: string;
  embeddingModel: string;
}

type ProviderModelMap = Record<ProviderKey, ProviderModels>;

// Provider model persistence helpers
const PROVIDER_MODELS_KEY = 'archon_provider_models';

const getDefaultModels = (provider: ProviderKey): ProviderModels => {
  const chatDefaults: Record<ProviderKey, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-20241022',
    google: 'gemini-1.5-flash',
    grok: 'grok-3-mini', // Updated to use grok-3-mini as default
    openrouter: 'openai/gpt-4o-mini',
    ollama: 'llama3:8b'
  };

  const embeddingDefaults: Record<ProviderKey, string> = {
    openai: 'text-embedding-3-small',
    anthropic: 'text-embedding-3-small', // Fallback to OpenAI
    google: 'text-embedding-004',
    grok: 'text-embedding-3-small', // Fallback to OpenAI
    openrouter: 'text-embedding-3-small',
    ollama: 'nomic-embed-text'
  };

  return {
    chatModel: chatDefaults[provider],
    embeddingModel: embeddingDefaults[provider]
  };
};

const saveProviderModels = (providerModels: ProviderModelMap): void => {
  try {
    localStorage.setItem(PROVIDER_MODELS_KEY, JSON.stringify(providerModels));
  } catch (error) {
    console.error('Failed to save provider models:', error);
  }
};

const loadProviderModels = (): ProviderModelMap => {
  try {
    const saved = localStorage.getItem(PROVIDER_MODELS_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (error) {
    console.error('Failed to load provider models:', error);
  }

  // Return defaults for all providers if nothing saved
  const providers: ProviderKey[] = ['openai', 'google', 'openrouter', 'ollama', 'anthropic', 'grok'];
  const defaultModels: ProviderModelMap = {} as ProviderModelMap;

  providers.forEach(provider => {
    defaultModels[provider] = getDefaultModels(provider);
  });

  return defaultModels;
};

// Static color styles mapping (prevents Tailwind JIT purging)
const colorStyles: Record<ProviderKey, string> = {
  openai: 'border-green-500 bg-green-500/10',
  google: 'border-blue-500 bg-blue-500/10',
  openrouter: 'border-cyan-500 bg-cyan-500/10',
  ollama: 'border-purple-500 bg-purple-500/10',
  anthropic: 'border-orange-500 bg-orange-500/10',
  grok: 'border-yellow-500 bg-yellow-500/10',
};

const providerWarningAlertStyle = 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-300';
const providerErrorAlertStyle = 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300';
const providerMissingAlertStyle = providerErrorAlertStyle;

const providerDisplayNames: Record<ProviderKey, string> = {
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  grok: 'Grok',
};

const isProviderKey = (value: unknown): value is ProviderKey =>
  typeof value === 'string' && ['openai', 'google', 'openrouter', 'ollama', 'anthropic', 'grok'].includes(value);

// Default base URL for Ollama instances when not explicitly configured
const DEFAULT_OLLAMA_URL = 'http://host.docker.internal:11434/v1';

const PROVIDER_CREDENTIAL_KEYS = [
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GROK_API_KEY',
] as const;

type ProviderCredentialKey = typeof PROVIDER_CREDENTIAL_KEYS[number];

const CREDENTIAL_PROVIDER_MAP: Record<ProviderCredentialKey, ProviderKey> = {
  OPENAI_API_KEY: 'openai',
  GOOGLE_API_KEY: 'google',
  ANTHROPIC_API_KEY: 'anthropic',
  OPENROUTER_API_KEY: 'openrouter',
  GROK_API_KEY: 'grok',
};

const normalizeBaseUrl = (url?: string | null): string | null => {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let normalized = trimmed.replace(/\/+$/, '');
  normalized = normalized.replace(/\/v1$/i, '');
  return normalized || null;
};

interface RAGSettingsProps {
  ragSettings: {
    MODEL_CHOICE: string;
    USE_CONTEXTUAL_EMBEDDINGS: boolean;
    CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: number;
    USE_HYBRID_SEARCH: boolean;
    USE_AGENTIC_RAG: boolean;
    USE_RERANKING: boolean;
    LLM_PROVIDER?: string;
    LLM_BASE_URL?: string;
    LLM_INSTANCE_NAME?: string;
    EMBEDDING_MODEL?: string;
    EMBEDDING_PROVIDER?: string;
    OLLAMA_EMBEDDING_URL?: string;
    OLLAMA_EMBEDDING_INSTANCE_NAME?: string;
    // Crawling Performance Settings
    CRAWL_BATCH_SIZE?: number;
    CRAWL_MAX_CONCURRENT?: number;
    CRAWL_WAIT_STRATEGY?: string;
    CRAWL_PAGE_TIMEOUT?: number;
    CRAWL_DELAY_BEFORE_HTML?: number;
    // Storage Performance Settings
    DOCUMENT_STORAGE_BATCH_SIZE?: number;
    EMBEDDING_BATCH_SIZE?: number;
    DELETE_BATCH_SIZE?: number;
    ENABLE_PARALLEL_BATCHES?: boolean;
    // Advanced Settings
    MEMORY_THRESHOLD_PERCENT?: number;
    DISPATCHER_CHECK_INTERVAL?: number;
    CODE_EXTRACTION_BATCH_SIZE?: number;
    CODE_SUMMARY_MAX_WORKERS?: number;
  };
  setRagSettings: (settings: any) => void;
}

export const RAGSettings = ({
  ragSettings,
  setRagSettings
}: RAGSettingsProps) => {
  const [saving, setSaving] = useState(false);
  const [showCrawlingSettings, setShowCrawlingSettings] = useState(false);
  const [showStorageSettings, setShowStorageSettings] = useState(false);
  const [showModelDiscoveryModal, setShowModelDiscoveryModal] = useState(false);
  const [showOllamaConfig, setShowOllamaConfig] = useState(false);
  
  // Edit modals state
  const [showEditLLMModal, setShowEditLLMModal] = useState(false);
  const [showEditEmbeddingModal, setShowEditEmbeddingModal] = useState(false);
  
  // Model selection modals state
  const [showLLMModelSelectionModal, setShowLLMModelSelectionModal] = useState(false);
  const [showEmbeddingModelSelectionModal, setShowEmbeddingModelSelectionModal] = useState(false);

  // Provider-specific model persistence state
  const [providerModels, setProviderModels] = useState<ProviderModelMap>(() => loadProviderModels());

  // Independent provider selection state
  const [chatProvider, setChatProvider] = useState<ProviderKey>(() =>
    (ragSettings.LLM_PROVIDER as ProviderKey) || 'openai'
  );
  const [embeddingProvider, setEmbeddingProvider] = useState<ProviderKey>(() =>
    // Default to openai if no specific embedding provider is set
    (ragSettings.EMBEDDING_PROVIDER as ProviderKey) || 'openai'
  );
  const [activeSelection, setActiveSelection] = useState<'chat' | 'embedding'>('chat');

  // Instance configurations
  const [llmInstanceConfig, setLLMInstanceConfig] = useState({
    name: '',
    url: ragSettings.LLM_BASE_URL || 'http://host.docker.internal:11434/v1'
  });
  const [embeddingInstanceConfig, setEmbeddingInstanceConfig] = useState({
    name: '', 
    url: ragSettings.OLLAMA_EMBEDDING_URL || 'http://host.docker.internal:11434/v1'
  });

  // Update instance configs when ragSettings change (after loading from database)
  // Use refs to prevent infinite loops
  const lastLLMConfigRef = useRef({ url: '', name: '' });
  const lastEmbeddingConfigRef = useRef({ url: '', name: '' });
  
  useEffect(() => {
    const newLLMUrl = ragSettings.LLM_BASE_URL || '';
    const newLLMName = ragSettings.LLM_INSTANCE_NAME || '';
    
    if (newLLMUrl !== lastLLMConfigRef.current.url || newLLMName !== lastLLMConfigRef.current.name) {
      lastLLMConfigRef.current = { url: newLLMUrl, name: newLLMName };
      setLLMInstanceConfig(prev => {
        const newConfig = {
          url: newLLMUrl || prev.url,
          name: newLLMName || prev.name
        };
        // Only update if actually different to prevent loops
        if (newConfig.url !== prev.url || newConfig.name !== prev.name) {
          return newConfig;
        }
        return prev;
      });
    }
  }, [ragSettings.LLM_BASE_URL, ragSettings.LLM_INSTANCE_NAME]);

  useEffect(() => {
    const newEmbeddingUrl = ragSettings.OLLAMA_EMBEDDING_URL || '';
    const newEmbeddingName = ragSettings.OLLAMA_EMBEDDING_INSTANCE_NAME || '';
    
    if (newEmbeddingUrl !== lastEmbeddingConfigRef.current.url || newEmbeddingName !== lastEmbeddingConfigRef.current.name) {
      lastEmbeddingConfigRef.current = { url: newEmbeddingUrl, name: newEmbeddingName };
      setEmbeddingInstanceConfig(prev => {
        const newConfig = {
          url: newEmbeddingUrl || prev.url,
          name: newEmbeddingName || prev.name
        };
        // Only update if actually different to prevent loops
        if (newConfig.url !== prev.url || newConfig.name !== prev.name) {
          return newConfig;
        }
        return prev;
      });
    }
  }, [ragSettings.OLLAMA_EMBEDDING_URL, ragSettings.OLLAMA_EMBEDDING_INSTANCE_NAME]);

  // Provider model persistence effects - separate for chat and embedding
  useEffect(() => {
    // Update chat provider models when chat model changes
    if (chatProvider && ragSettings.MODEL_CHOICE) {
      setProviderModels(prev => {
        const updated = {
          ...prev,
          [chatProvider]: {
            ...prev[chatProvider],
            chatModel: ragSettings.MODEL_CHOICE
          }
        };
        saveProviderModels(updated);
        return updated;
      });
    }
  }, [ragSettings.MODEL_CHOICE, chatProvider]);

  useEffect(() => {
    // Update embedding provider models when embedding model changes
    if (embeddingProvider && ragSettings.EMBEDDING_MODEL) {
      setProviderModels(prev => {
        const updated = {
          ...prev,
          [embeddingProvider]: {
            ...prev[embeddingProvider],
            embeddingModel: ragSettings.EMBEDDING_MODEL
          }
        };
        saveProviderModels(updated);
        return updated;
      });
    }
  }, [ragSettings.EMBEDDING_MODEL, embeddingProvider]);

  const hasLoadedCredentialsRef = useRef(false);

  const reloadApiCredentials = useCallback(async () => {
    try {
      const statusResults = await credentialsService.checkCredentialStatus(
        Array.from(PROVIDER_CREDENTIAL_KEYS),
      );

      const credentials: { [key: string]: boolean } = {};

      for (const key of PROVIDER_CREDENTIAL_KEYS) {
        const result = statusResults[key];
        credentials[key] = !!result?.has_value;
      }

      console.log(
        '🔑 Updated API credential status snapshot:',
        Object.keys(credentials),
      );
      setApiCredentials(credentials);
      hasLoadedCredentialsRef.current = true;
    } catch (error) {
      console.error('Failed to load API credentials for status checking:', error);
    }
  }, []);

  useEffect(() => {
    void reloadApiCredentials();
  }, [reloadApiCredentials]);

  useEffect(() => {
    if (!hasLoadedCredentialsRef.current) {
      return;
    }

    void reloadApiCredentials();
  }, [ragSettings.LLM_PROVIDER, reloadApiCredentials]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (Object.keys(ragSettings).length > 0) {
        void reloadApiCredentials();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [ragSettings.LLM_PROVIDER, reloadApiCredentials]);

  useEffect(() => {
    const needsDetection = chatProvider === 'ollama' || embeddingProvider === 'ollama';

    if (!needsDetection) {
      setOllamaServerStatus('unknown');
      return;
    }

    const baseUrl = (
      ragSettings.LLM_BASE_URL?.trim() ||
      llmInstanceConfig.url?.trim() ||
      ragSettings.OLLAMA_EMBEDDING_URL?.trim() ||
      embeddingInstanceConfig.url?.trim() ||
      DEFAULT_OLLAMA_URL
    );

    const normalizedUrl = baseUrl.replace('/v1', '').replace(/\/$/, '');

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          `/api/ollama/instances/health?instance_urls=${encodeURIComponent(normalizedUrl)}`,
          { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
        );

        if (cancelled) return;

        if (!response.ok) {
          setOllamaServerStatus('offline');
          return;
        }

        const data = await response.json();
        const instanceStatus = data.instance_status?.[normalizedUrl];
        setOllamaServerStatus(instanceStatus?.is_healthy ? 'online' : 'offline');
      } catch (error) {
        if (!cancelled) {
          setOllamaServerStatus('offline');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chatProvider, embeddingProvider, ragSettings.LLM_BASE_URL, ragSettings.OLLAMA_EMBEDDING_URL, llmInstanceConfig.url, embeddingInstanceConfig.url]);

  // Sync independent provider states with ragSettings (one-way: ragSettings -> local state)
  useEffect(() => {
    if (ragSettings.LLM_PROVIDER && ragSettings.LLM_PROVIDER !== chatProvider) {
      setChatProvider(ragSettings.LLM_PROVIDER as ProviderKey);
    }
  }, [ragSettings.LLM_PROVIDER]); // Remove chatProvider dependency to avoid loops

  useEffect(() => {
    if (ragSettings.EMBEDDING_PROVIDER && ragSettings.EMBEDDING_PROVIDER !== embeddingProvider) {
      setEmbeddingProvider(ragSettings.EMBEDDING_PROVIDER as ProviderKey);
    }
  }, [ragSettings.EMBEDDING_PROVIDER]); // Remove embeddingProvider dependency to avoid loops

  useEffect(() => {
    setOllamaManualConfirmed(false);
    setOllamaServerStatus('unknown');
  }, [ragSettings.LLM_BASE_URL, ragSettings.OLLAMA_EMBEDDING_URL, chatProvider, embeddingProvider]);

  // Update ragSettings when independent providers change (one-way: local state -> ragSettings)
  // Split the “first‐run” guard into two refs so chat and embedding effects don’t interfere.
  const updateChatRagSettingsRef = useRef(true);
  const updateEmbeddingRagSettingsRef = useRef(true);

  useEffect(() => {
    // Only update if this is a user‐initiated change, not a sync from ragSettings
    if (updateChatRagSettingsRef.current && chatProvider !== ragSettings.LLM_PROVIDER) {
      setRagSettings(prev => ({
        ...prev,
        LLM_PROVIDER: chatProvider
      }));
    }
    updateChatRagSettingsRef.current = true;
  }, [chatProvider]);

  useEffect(() => {
    // Only update if this is a user‐initiated change, not a sync from ragSettings
    if (updateEmbeddingRagSettingsRef.current && embeddingProvider && embeddingProvider !== ragSettings.EMBEDDING_PROVIDER) {
      setRagSettings(prev => ({
        ...prev,
        EMBEDDING_PROVIDER: embeddingProvider
      }));
    }
    updateEmbeddingRagSettingsRef.current = true;
  }, [embeddingProvider]);


  // Status tracking
  const [llmStatus, setLLMStatus] = useState({ online: false, responseTime: null, checking: false });
  const [embeddingStatus, setEmbeddingStatus] = useState({ online: false, responseTime: null, checking: false });
  const llmRetryTimeoutRef = useRef<number | null>(null);
  const embeddingRetryTimeoutRef = useRef<number | null>(null);
  
  // API key credentials for status checking
  const [apiCredentials, setApiCredentials] = useState<{[key: string]: boolean}>({});
  // Provider connection status tracking
  const [providerConnectionStatus, setProviderConnectionStatus] = useState<{
    [key: string]: { connected: boolean; checking: boolean; lastChecked?: Date }
  }>({});
  const [ollamaServerStatus, setOllamaServerStatus] = useState<'unknown' | 'online' | 'offline'>('unknown');
  const [ollamaManualConfirmed, setOllamaManualConfirmed] = useState(false);

  useEffect(() => {
    return () => {
      if (llmRetryTimeoutRef.current) {
        clearTimeout(llmRetryTimeoutRef.current);
        llmRetryTimeoutRef.current = null;
      }
      if (embeddingRetryTimeoutRef.current) {
        clearTimeout(embeddingRetryTimeoutRef.current);
        embeddingRetryTimeoutRef.current = null;
      }
    };
  }, []);

  // Test connection to external providers
  const testProviderConnection = useCallback(async (provider: string): Promise<boolean> => {
    setProviderConnectionStatus(prev => ({
      ...prev,
      [provider]: { ...prev[provider], checking: true }
    }));

    try {
      // Use server-side API endpoint for secure connectivity testing
      const response = await fetch(`/api/providers/${provider}/status`);
      const result = await response.json();

      const isConnected = result.ok && result.reason === 'connected';

      setProviderConnectionStatus(prev => ({
        ...prev,
        [provider]: { connected: isConnected, checking: false, lastChecked: new Date() }
      }));

      return isConnected;
    } catch (error) {
      console.error(`Error testing ${provider} connection:`, error);
      setProviderConnectionStatus(prev => ({
        ...prev,
        [provider]: { connected: false, checking: false, lastChecked: new Date() }
      }));
      return false;
    }
  }, []);

  // Test provider connections when API credentials change
  useEffect(() => {
    const testConnections = async () => {
      // Test all supported providers
      const providers = ['openai', 'google', 'anthropic', 'openrouter', 'grok'];

      for (const provider of providers) {
        // Don't test if we've already checked recently (within last 30 seconds)
        const lastChecked = providerConnectionStatus[provider]?.lastChecked;
        const now = new Date();
        const timeSinceLastCheck = lastChecked ? now.getTime() - lastChecked.getTime() : Infinity;

        if (timeSinceLastCheck > 30000) { // 30 seconds
          console.log(`🔄 Testing ${provider} connection...`);
          await testProviderConnection(provider);
        }
      }
    };

    // Test connections periodically (every 60 seconds)
    testConnections();
    const interval = setInterval(testConnections, 60000);

    return () => clearInterval(interval);
  }, [apiCredentials, testProviderConnection]); // Test when credentials change

  useEffect(() => {
    const handleCredentialUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: string[] }>).detail;
      const updatedKeys = (detail?.keys ?? []).map(key => key.toUpperCase());

      if (updatedKeys.length === 0) {
        void reloadApiCredentials();
        return;
      }

      const touchedProviderKeys = updatedKeys.filter(key => key in CREDENTIAL_PROVIDER_MAP);
      if (touchedProviderKeys.length === 0) {
        return;
      }

      void reloadApiCredentials();

      touchedProviderKeys.forEach(key => {
        const provider = CREDENTIAL_PROVIDER_MAP[key as ProviderCredentialKey];
        if (provider) {
          void testProviderConnection(provider);
        }
      });
    };

    window.addEventListener('archon:credentials-updated', handleCredentialUpdate);

    return () => {
      window.removeEventListener('archon:credentials-updated', handleCredentialUpdate);
    };
  }, [reloadApiCredentials, testProviderConnection]);

  // Ref to track if initial test has been run (will be used after function definitions)
  const hasRunInitialTestRef = useRef(false);
  
  // Ollama metrics state
  const [ollamaMetrics, setOllamaMetrics] = useState({
    totalModels: 0,
    chatModels: 0,
    embeddingModels: 0,
    activeHosts: 0,
    loading: true,
    // Per-instance model counts
    llmInstanceModels: { chat: 0, embedding: 0, total: 0 },
    embeddingInstanceModels: { chat: 0, embedding: 0, total: 0 }
  });
  const { showToast } = useToast();

  // Function to test connection status using backend proxy
  const testConnection = async (url: string, setStatus: React.Dispatch<React.SetStateAction<{ online: boolean; responseTime: number | null; checking: boolean }>>) => {
    setStatus(prev => ({ ...prev, checking: true }));
    const startTime = Date.now();
    
    try {
      // Strip /v1 suffix for backend health check (backend expects base Ollama URL)
      const baseUrl = url.replace('/v1', '').replace(/\/$/, '');
      
      // Use the backend health check endpoint to avoid CORS issues
      const backendHealthUrl = `/api/ollama/instances/health?instance_urls=${encodeURIComponent(baseUrl)}&include_models=true`;
      
      const response = await fetch(backendHealthUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000)
      });
      
      if (response.ok) {
        const data = await response.json();
        const instanceStatus = data.instance_status?.[baseUrl];
        
        if (instanceStatus?.is_healthy) {
          const responseTime = Math.round(instanceStatus.response_time_ms || (Date.now() - startTime));
          setStatus({ online: true, responseTime, checking: false });
          console.log(`✅ ${url} online: ${responseTime}ms (${instanceStatus.models_available || 0} models)`);
        } else {
          setStatus({ online: false, responseTime: null, checking: false });
          console.log(`❌ ${url} unhealthy: ${instanceStatus?.error_message || 'No status available'}`);
        }
      } else {
        throw new Error(`Backend health check failed: HTTP ${response.status}`);
      }
      
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      setStatus({ online: false, responseTime, checking: false });
      
      let errorMessage = 'Connection failed';
      if (error.name === 'AbortError') {
        errorMessage = 'Request timeout (>15s)';
      } else if (error.message.includes('Backend health check failed')) {
        errorMessage = 'Backend proxy error';
      } else {
        errorMessage = error.message || 'Unknown error';
      }
      
      console.log(`❌ ${url} failed: ${errorMessage} (${responseTime}ms)`);
    }
  };

  // Manual test function with user feedback using backend proxy
const manualTestConnection = async (
    url: string,
    setStatus: React.Dispatch<React.SetStateAction<{ online: boolean; responseTime: number | null; checking: boolean }>>,
    instanceName: string,
    context?: 'chat' | 'embedding',
    options?: { suppressToast?: boolean }
  ): Promise<boolean> => {
    const suppressToast = options?.suppressToast ?? false;
    setStatus(prev => ({ ...prev, checking: true }));
    const startTime = Date.now();
    
    try {
      // Strip /v1 suffix for backend health check (backend expects base Ollama URL)
      const baseUrl = url.replace('/v1', '').replace(/\/$/, '');
      
      // Use the backend health check endpoint to avoid CORS issues
      const backendHealthUrl = `/api/ollama/instances/health?instance_urls=${encodeURIComponent(baseUrl)}&include_models=true`;
      
      const response = await fetch(backendHealthUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000)
      });
      
      if (response.ok) {
        const data = await response.json();
        const instanceStatus = data.instance_status?.[baseUrl];
        
        if (instanceStatus?.is_healthy) {
          const responseTime = Math.round(instanceStatus.response_time_ms || (Date.now() - startTime));
          setStatus({ online: true, responseTime, checking: false });

          // Context-aware model count display
          let modelCount = instanceStatus.models_available || 0;
          let modelType = 'models';

          if (context === 'chat') {
            modelCount = ollamaMetrics.llmInstanceModels?.chat || 0;
            modelType = 'chat models';
          } else if (context === 'embedding') {
            modelCount = ollamaMetrics.embeddingInstanceModels?.embedding || 0;
            modelType = 'embedding models';
          }

          if (!suppressToast) {
            showToast(`${instanceName} connection successful: ${modelCount} ${modelType} available (${responseTime}ms)`, 'success');
          }

          // Scenario 2: Manual "Test Connection" button - refresh Ollama metrics if Ollama provider is selected
          if (ragSettings.LLM_PROVIDER === 'ollama' || embeddingProvider === 'ollama' || context === 'embedding') {
            console.log('🔄 Fetching Ollama metrics - Test Connection button clicked');
            fetchOllamaMetrics();
          }

          return true;
        } else {
          setStatus({ online: false, responseTime: null, checking: false });
          if (!suppressToast) {
            showToast(`${instanceName} connection failed: ${instanceStatus?.error_message || 'Instance is not healthy'}`, 'error');
          }
          return false;
        }
      } else {
        setStatus({ online: false, responseTime: null, checking: false });
        if (!suppressToast) {
          showToast(`${instanceName} connection failed: Backend proxy error (HTTP ${response.status})`, 'error');
        }
        return false;
      }
    } catch (error: any) {
      setStatus({ online: false, responseTime: null, checking: false });

      if (!suppressToast) {
        if (error.name === 'AbortError') {
          showToast(`${instanceName} connection failed: Request timeout (>15s)`, 'error');
        } else {
          showToast(`${instanceName} connection failed: ${error.message || 'Unknown error'}`, 'error');
        }
      }

      return false;
    }
  };

  // Function to handle LLM instance deletion
  const handleDeleteLLMInstance = () => {
    if (window.confirm('Are you sure you want to delete the current LLM instance configuration?')) {
      // Reset LLM instance configuration
      setLLMInstanceConfig({
        name: '',
        url: ''
      });
      
      // Clear related RAG settings
      const updatedSettings = { ...ragSettings };
      delete updatedSettings.LLM_BASE_URL;
      delete updatedSettings.MODEL_CHOICE;
      setRagSettings(updatedSettings);
      
      // Reset status
      setLLMStatus({ online: false, responseTime: null, checking: false });
      
      showToast('LLM instance configuration deleted', 'success');
    }
  };

  // Function to handle Embedding instance deletion
  const handleDeleteEmbeddingInstance = () => {
    if (window.confirm('Are you sure you want to delete the current Embedding instance configuration?')) {
      // Reset Embedding instance configuration
      setEmbeddingInstanceConfig({
        name: '',
        url: ''
      });
      
      // Clear related RAG settings
      const updatedSettings = { ...ragSettings };
      delete updatedSettings.OLLAMA_EMBEDDING_URL;
      delete updatedSettings.EMBEDDING_MODEL;
      setRagSettings(updatedSettings);
      
      // Reset status
      setEmbeddingStatus({ online: false, responseTime: null, checking: false });
      
      showToast('Embedding instance configuration deleted', 'success');
    }
  };

  // Function to fetch Ollama metrics
  const fetchOllamaMetrics = async () => {
    try {
      setOllamaMetrics(prev => ({ ...prev, loading: true }));

      // Prepare normalized instance URLs for the API call
      const instanceUrls: string[] = [];
      const llmUrlBase = normalizeBaseUrl(llmInstanceConfig.url);
      const embUrlBase = normalizeBaseUrl(embeddingInstanceConfig.url);

      if (llmUrlBase) instanceUrls.push(llmUrlBase);
      if (embUrlBase && embUrlBase !== llmUrlBase) {
        instanceUrls.push(embUrlBase);
      }

      if (instanceUrls.length === 0) {
        setOllamaMetrics(prev => ({ ...prev, loading: false }));
        return;
      }

      // Build query parameters
      const params = new URLSearchParams();
      instanceUrls.forEach(url => params.append('instance_urls', url));
      params.append('include_capabilities', 'true');

      // Fetch models from configured instances
      const modelsResponse = await fetch(`/api/ollama/models?${params.toString()}`);
      const modelsData = await modelsResponse.json();

      if (modelsResponse.ok) {
        // Extract models from the response
        const allChatModels = modelsData.chat_models || [];
        const allEmbeddingModels = modelsData.embedding_models || [];
        
        // Count models for LLM instance
        const llmChatModels = allChatModels.filter((model: any) => 
          normalizeBaseUrl(model.instance_url) === llmUrlBase
        );
        const llmEmbeddingModels = allEmbeddingModels.filter((model: any) => 
          normalizeBaseUrl(model.instance_url) === llmUrlBase
        );

        // Count models for Embedding instance
        const embChatModels = allChatModels.filter((model: any) => 
          normalizeBaseUrl(model.instance_url) === embUrlBase
        );
        const embEmbeddingModels = allEmbeddingModels.filter((model: any) => 
          normalizeBaseUrl(model.instance_url) === embUrlBase
        );
        
        // Calculate totals
        const totalModels = modelsData.total_models || 0;
        const activeHosts = (llmStatus.online ? 1 : 0) + (embeddingStatus.online ? 1 : 0);

        setOllamaMetrics({
          totalModels: totalModels,
          chatModels: allChatModels.length,
          embeddingModels: allEmbeddingModels.length,
          activeHosts,
          loading: false,
          // Per-instance model counts
          llmInstanceModels: {
            chat: llmChatModels.length,
            embedding: llmEmbeddingModels.length,
            total: llmChatModels.length + llmEmbeddingModels.length
          },
          embeddingInstanceModels: {
            chat: embChatModels.length,
            embedding: embEmbeddingModels.length,
            total: embChatModels.length + embEmbeddingModels.length
          }
        });
      } else {
        console.error('Failed to fetch models:', modelsData);
        setOllamaMetrics(prev => ({ ...prev, loading: false }));
      }
    } catch (error) {
      console.error('Error fetching Ollama metrics:', error);
      setOllamaMetrics(prev => ({ ...prev, loading: false }));
    }
  };

  // Auto-check status when instances are configured or when Ollama is selected
  // Use refs to prevent infinite connection testing
  const lastTestedLLMConfigRef = useRef({ url: '', name: '', provider: '' });
  const lastTestedEmbeddingConfigRef = useRef({ url: '', name: '', provider: '' });
  const lastMetricsFetchRef = useRef({ provider: '', embProvider: '', llmUrl: '', embUrl: '', llmOnline: false, embOnline: false });
  
  // Auto-testing disabled to prevent API calls on every keystroke per user request
  // Connection testing should only happen on manual "Test Connection" or "Save Changes" button clicks
  // React.useEffect(() => {
  //   const currentConfig = {
  //     url: llmInstanceConfig.url,
  //     name: llmInstanceConfig.name,
  //     provider: ragSettings.LLM_PROVIDER
  //   };
  //   
  //   const shouldTest = ragSettings.LLM_PROVIDER === 'ollama' && 
  //                     llmInstanceConfig.url && 
  //                     llmInstanceConfig.name && 
  //                     llmInstanceConfig.url !== 'http://localhost:11434/v1' &&
  //                     (currentConfig.url !== lastTestedLLMConfigRef.current.url ||
  //                      currentConfig.name !== lastTestedLLMConfigRef.current.name ||
  //                      currentConfig.provider !== lastTestedLLMConfigRef.current.provider);
  //   
  //   if (shouldTest) {
  //     lastTestedLLMConfigRef.current = currentConfig;
  //     testConnection(llmInstanceConfig.url, setLLMStatus);
  //   }
  // }, [llmInstanceConfig.url, llmInstanceConfig.name, ragSettings.LLM_PROVIDER]);

  // Auto-testing disabled to prevent API calls on every keystroke per user request
  // Connection testing should only happen on manual "Test Connection" or "Save Changes" button clicks
  // React.useEffect(() => {
  //   const currentConfig = {
  //     url: embeddingInstanceConfig.url,
  //     name: embeddingInstanceConfig.name,
  //     provider: ragSettings.LLM_PROVIDER
  //   };
  //   
  //   const shouldTest = ragSettings.LLM_PROVIDER === 'ollama' && 
  //                     embeddingInstanceConfig.url && 
  //                     embeddingInstanceConfig.name && 
  //                     embeddingInstanceConfig.url !== 'http://localhost:11434/v1' &&
  //                     (currentConfig.url !== lastTestedEmbeddingConfigRef.current.url ||
  //                      currentConfig.name !== lastTestedEmbeddingConfigRef.current.name ||
  //                      currentConfig.provider !== lastTestedEmbeddingConfigRef.current.provider);
  //   
  //   if (shouldTest) {
  //     lastTestedEmbeddingConfigRef.current = currentConfig;
  //     testConnection(embeddingInstanceConfig.url, setEmbeddingStatus);
  //   }
  // }, [embeddingInstanceConfig.url, embeddingInstanceConfig.name, ragSettings.LLM_PROVIDER]);

  React.useEffect(() => {
    const current = {
      provider: ragSettings.LLM_PROVIDER,
      embProvider: embeddingProvider,
      llmUrl: normalizeBaseUrl(llmInstanceConfig.url) ?? '',
      embUrl: normalizeBaseUrl(embeddingInstanceConfig.url) ?? '',
      llmOnline: llmStatus.online,
      embOnline: embeddingStatus.online,
    };
    const last = lastMetricsFetchRef.current;

    const meaningfulChange =
      current.provider !== last.provider ||
      current.embProvider !== last.embProvider ||
      current.llmUrl !== last.llmUrl ||
      current.embUrl !== last.embUrl ||
      current.llmOnline !== last.llmOnline ||
      current.embOnline !== last.embOnline;

    if ((current.provider === 'ollama' || current.embProvider === 'ollama') && meaningfulChange) {
      lastMetricsFetchRef.current = current;
      console.log('🔄 Fetching Ollama metrics - state changed');
      fetchOllamaMetrics();
    }
  }, [ragSettings.LLM_PROVIDER, embeddingProvider, llmStatus.online, embeddingStatus.online]);

  const hasApiCredential = (credentialKey: ProviderCredentialKey): boolean => {
    if (credentialKey in apiCredentials) {
      return Boolean(apiCredentials[credentialKey]);
    }

    const fallbackKey = Object.keys(apiCredentials).find(
      key => key.toUpperCase() === credentialKey,
    );

    return fallbackKey ? Boolean(apiCredentials[fallbackKey]) : false;
  };

  // Function to check if a provider is properly configured
  const getProviderStatus = (providerKey: string): 'configured' | 'missing' | 'partial' => {
    switch (providerKey) {
      case 'openai':
        const hasOpenAIKey = hasApiCredential('OPENAI_API_KEY');

        // Only show configured if we have both API key AND confirmed connection
        const openAIConnected = providerConnectionStatus['openai']?.connected || false;
        const isChecking = providerConnectionStatus['openai']?.checking || false;

        // Intentionally avoid logging API key material.

        if (!hasOpenAIKey) return 'missing';
        if (isChecking) return 'partial';
        return openAIConnected ? 'configured' : 'missing';
        
      case 'google':
        const hasGoogleKey = hasApiCredential('GOOGLE_API_KEY');
        
        // Only show configured if we have both API key AND confirmed connection
        const googleConnected = providerConnectionStatus['google']?.connected || false;
        const googleChecking = providerConnectionStatus['google']?.checking || false;

        if (!hasGoogleKey) return 'missing';
        if (googleChecking) return 'partial';
        return googleConnected ? 'configured' : 'missing';
        
      case 'ollama':
        {
          if (ollamaManualConfirmed || llmStatus.online || embeddingStatus.online) {
            return 'configured';
          }

          if (ollamaServerStatus === 'online') {
            return 'partial';
          }

          if (ollamaServerStatus === 'offline') {
            return 'missing';
          }

          return 'missing';
        }
      case 'anthropic':
        const hasAnthropicKey = hasApiCredential('ANTHROPIC_API_KEY');
        const anthropicConnected = providerConnectionStatus['anthropic']?.connected || false;
        const anthropicChecking = providerConnectionStatus['anthropic']?.checking || false;
        if (!hasAnthropicKey) return 'missing';
        if (anthropicChecking) return 'partial';
        return anthropicConnected ? 'configured' : 'missing';
      case 'grok':
        const hasGrokKey = hasApiCredential('GROK_API_KEY');
        const grokConnected = providerConnectionStatus['grok']?.connected || false;
        const grokChecking = providerConnectionStatus['grok']?.checking || false;
        if (!hasGrokKey) return 'missing';
        if (grokChecking) return 'partial';
        return grokConnected ? 'configured' : 'missing';
      case 'openrouter':
        const hasOpenRouterKey = hasApiCredential('OPENROUTER_API_KEY');
        const openRouterConnected = providerConnectionStatus['openrouter']?.connected || false;
        const openRouterChecking = providerConnectionStatus['openrouter']?.checking || false;
        if (!hasOpenRouterKey) return 'missing';
        if (openRouterChecking) return 'partial';
        return openRouterConnected ? 'configured' : 'missing';
      default:
        return 'missing';
    }
  };

  const resolvedProviderForAlert = activeSelection === 'chat' ? chatProvider : embeddingProvider;
  const activeProviderKey = isProviderKey(resolvedProviderForAlert)
    ? (resolvedProviderForAlert as ProviderKey)
    : undefined;
  const selectedProviderStatus = activeProviderKey ? getProviderStatus(activeProviderKey) : undefined;

  let providerAlertMessage: string | null = null;
  let providerAlertClassName = '';

  if (activeProviderKey === 'ollama') {
    if (ollamaServerStatus === 'offline') {
      providerAlertMessage = 'Local Ollama service is not running. Start the Ollama server and ensure it is reachable at the configured URL.';
      providerAlertClassName = providerErrorAlertStyle;
    } else if (selectedProviderStatus === 'partial' && ollamaServerStatus === 'online') {
      providerAlertMessage = 'Local Ollama service detected. Click "Test Connection" to confirm model availability.';
      providerAlertClassName = providerWarningAlertStyle;
    }
  } else if (activeProviderKey && selectedProviderStatus === 'missing') {
    const providerName = providerDisplayNames[activeProviderKey] ?? activeProviderKey;
    providerAlertMessage = `${providerName} API key is not configured. Add it in Settings > API Keys.`;
    providerAlertClassName = providerMissingAlertStyle;
  }

  const shouldShowProviderAlert = Boolean(providerAlertMessage);
  
  useEffect(() => {
    if (chatProvider !== 'ollama') {
      if (llmRetryTimeoutRef.current) {
        clearTimeout(llmRetryTimeoutRef.current);
        llmRetryTimeoutRef.current = null;
      }
      return;
    }

    const baseUrl = (
      ragSettings.LLM_BASE_URL?.trim() ||
      llmInstanceConfig.url?.trim() ||
      DEFAULT_OLLAMA_URL
    );

    if (!baseUrl) {
      return;
    }

    const instanceName = llmInstanceConfig.name?.trim().length
      ? llmInstanceConfig.name
      : 'LLM Instance';

    let cancelled = false;

    const runTest = async () => {
      if (cancelled) return;

      const success = await manualTestConnection(
        baseUrl,
        setLLMStatus,
        instanceName,
        'chat',
        { suppressToast: true }
      );

      if (!success && chatProvider === 'ollama' && !cancelled) {
        llmRetryTimeoutRef.current = window.setTimeout(runTest, 5000);
      }
    };

    if (llmRetryTimeoutRef.current) {
      clearTimeout(llmRetryTimeoutRef.current);
      llmRetryTimeoutRef.current = null;
    }

    setLLMStatus(prev => ({ ...prev, checking: true }));
    runTest();

    return () => {
      cancelled = true;
      if (llmRetryTimeoutRef.current) {
        clearTimeout(llmRetryTimeoutRef.current);
        llmRetryTimeoutRef.current = null;
      }
    };
  }, [chatProvider, ragSettings.LLM_BASE_URL, ragSettings.LLM_INSTANCE_NAME, llmInstanceConfig.url, llmInstanceConfig.name]);

  useEffect(() => {
    if (embeddingProvider !== 'ollama') {
      if (embeddingRetryTimeoutRef.current) {
        clearTimeout(embeddingRetryTimeoutRef.current);
        embeddingRetryTimeoutRef.current = null;
      }
      return;
    }

    const baseUrl = (
      ragSettings.OLLAMA_EMBEDDING_URL?.trim() ||
      embeddingInstanceConfig.url?.trim() ||
      DEFAULT_OLLAMA_URL
    );

    if (!baseUrl) {
      return;
    }

    const instanceName = embeddingInstanceConfig.name?.trim().length
      ? embeddingInstanceConfig.name
      : 'Embedding Instance';

    let cancelled = false;

    const runTest = async () => {
      if (cancelled) return;

      const success = await manualTestConnection(
        baseUrl,
        setEmbeddingStatus,
        instanceName,
        'embedding',
        { suppressToast: true }
      );

      if (!success && embeddingProvider === 'ollama' && !cancelled) {
        embeddingRetryTimeoutRef.current = window.setTimeout(runTest, 5000);
      }
    };

    if (embeddingRetryTimeoutRef.current) {
      clearTimeout(embeddingRetryTimeoutRef.current);
      embeddingRetryTimeoutRef.current = null;
    }

    setEmbeddingStatus(prev => ({ ...prev, checking: true }));
    runTest();

    return () => {
      cancelled = true;
      if (embeddingRetryTimeoutRef.current) {
        clearTimeout(embeddingRetryTimeoutRef.current);
        embeddingRetryTimeoutRef.current = null;
      }
    };
  }, [embeddingProvider, ragSettings.OLLAMA_EMBEDDING_URL, ragSettings.OLLAMA_EMBEDDING_INSTANCE_NAME, embeddingInstanceConfig.url, embeddingInstanceConfig.name]);

  // Test Ollama connectivity when Settings page loads (scenario 4: page load)
  // This useEffect is placed after function definitions to ensure access to manualTestConnection
  useEffect(() => {
    console.log('🔍 Page load check:', {
      hasRunInitialTest: hasRunInitialTestRef.current,
      provider: ragSettings.LLM_PROVIDER,
      ragSettingsCount: Object.keys(ragSettings).length,
      llmUrl: llmInstanceConfig.url,
      llmName: llmInstanceConfig.name,
      embUrl: embeddingInstanceConfig.url,
      embName: embeddingInstanceConfig.name
    });
    
    // Only run once when data is properly loaded and not run before
    if (
      !hasRunInitialTestRef.current &&
      (ragSettings.LLM_PROVIDER === 'ollama' || embeddingProvider === 'ollama') &&
      Object.keys(ragSettings).length > 0
    ) {
      
      hasRunInitialTestRef.current = true;
      console.log('🔄 Settings page loaded with Ollama - Testing connectivity');

      // Test LLM instance if a URL is available (either saved or default)
      if (llmInstanceConfig.url) {
        setTimeout(() => {
          const instanceName = llmInstanceConfig.name || 'LLM Instance';
          console.log('🔍 Testing LLM instance on page load:', instanceName, llmInstanceConfig.url);
          manualTestConnection(
            llmInstanceConfig.url,
            setLLMStatus,
            instanceName,
            'chat',
            { suppressToast: true }
          );
        }, 1000); // Increased delay to ensure component is fully ready
      }
      // If no saved URL, run tests against default endpoint
      else {
        setTimeout(() => {
          const defaultInstanceName = 'Local Ollama (Default)';
          console.log('🔍 Testing default Ollama chat instance on page load:', DEFAULT_OLLAMA_URL);
          manualTestConnection(
            DEFAULT_OLLAMA_URL,
            setLLMStatus,
            defaultInstanceName,
            'chat',
            { suppressToast: true }
          );
        }, 1000);
      }

      // Test Embedding instance if configured and different from LLM instance
      if (embeddingInstanceConfig.url &&
          embeddingInstanceConfig.url !== llmInstanceConfig.url) {
        setTimeout(() => {
          const instanceName = embeddingInstanceConfig.name || 'Embedding Instance';
          console.log('🔍 Testing Embedding instance on page load:', instanceName, embeddingInstanceConfig.url);
          manualTestConnection(
            embeddingInstanceConfig.url,
            setEmbeddingStatus,
            instanceName,
            'embedding',
            { suppressToast: true }
          );
        }, 1500); // Stagger the tests
      }
      // If embedding provider is also Ollama but no specific URL is set, test default as fallback
      else if (embeddingProvider === 'ollama' && !embeddingInstanceConfig.url) {
        setTimeout(() => {
          const defaultEmbeddingName = 'Local Ollama (Default)';
          console.log('🔍 Testing default Ollama embedding instance on page load:', DEFAULT_OLLAMA_URL);
          manualTestConnection(
            DEFAULT_OLLAMA_URL,
            setEmbeddingStatus,
            defaultEmbeddingName,
            'embedding',
            { suppressToast: true }
          );
        }, 1500);
      }

      // Fetch Ollama metrics after testing connections
      setTimeout(() => {
        console.log('📊 Fetching Ollama metrics on page load');
        fetchOllamaMetrics();
      }, 2000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ragSettings.LLM_PROVIDER, llmInstanceConfig.url, llmInstanceConfig.name, 
      embeddingInstanceConfig.url, embeddingInstanceConfig.name]); // Don't include function deps to avoid re-runs
  
  return <Card accentColor="green" className="overflow-hidden p-8">
        {/* Description */}
        <p className="text-sm text-gray-600 dark:text-zinc-400 mb-6">
          Configure Retrieval-Augmented Generation (RAG) strategies for optimal
          knowledge retrieval.
        </p>
        
        {/* LLM Provider Settings Header */}
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            LLM Provider Settings
          </h2>
        </div>

        {/* Provider Selection Buttons */}
        <div className="flex gap-4 mb-6">
          <GlowButton
            onClick={() => setActiveSelection('chat')}
            variant="ghost"
            className={`min-w-[180px] px-5 py-3 font-semibold text-white dark:text-white
              border border-emerald-400/70 dark:border-emerald-400/40
              bg-black/40 backdrop-blur-md
              shadow-[inset_0_0_16px_rgba(15,118,110,0.38)]
              hover:bg-emerald-500/12 dark:hover:bg-emerald-500/20
              hover:border-emerald-300/80 hover:shadow-[0_0_22px_rgba(16,185,129,0.5)]
              ${(activeSelection === 'chat')
                ? 'shadow-[0_0_25px_rgba(16,185,129,0.5)] ring-2 ring-emerald-400/50'
                : 'shadow-[0_0_15px_rgba(16,185,129,0.25)]'}
            `}
          >
            <span className="flex items-center justify-center gap-2">
              <LuBrainCircuit className="w-4 h-4 text-emerald-300" aria-hidden="true" />
              <span>Chat: {chatProvider}</span>
            </span>
          </GlowButton>
          <GlowButton
            onClick={() => setActiveSelection('embedding')}
            variant="ghost"
            className={`min-w-[180px] px-5 py-3 font-semibold text-white dark:text-white
              border border-purple-400/70 dark:border-purple-400/40
              bg-black/40 backdrop-blur-md
              shadow-[inset_0_0_16px_rgba(109,40,217,0.38)]
              hover:bg-purple-500/12 dark:hover:bg-purple-500/20
              hover:border-purple-300/80 hover:shadow-[0_0_24px_rgba(168,85,247,0.52)]
              ${(activeSelection === 'embedding')
                ? 'shadow-[0_0_26px_rgba(168,85,247,0.55)] ring-2 ring-purple-400/60'
                : 'shadow-[0_0_15px_rgba(168,85,247,0.25)]'}
            `}
          >
            <span className="flex items-center justify-center gap-2">
              <PiDatabaseThin className="w-4 h-4 text-purple-300" aria-hidden="true" />
              <span>Embeddings: {embeddingProvider}</span>
            </span>
          </GlowButton>
        </div>

        {/* Context-Aware Provider Grid */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            Select {activeSelection === 'chat' ? 'Chat' : 'Embedding'} Provider
          </label>
          <div className={`grid gap-3 mb-4 ${
            activeSelection === 'chat' ? 'grid-cols-6' : 'grid-cols-3'
          }`}>
            {[
              { key: 'openai', name: 'OpenAI', logo: '/img/OpenAI.png', color: 'green' },
              { key: 'google', name: 'Google', logo: '/img/google-logo.svg', color: 'blue' },
              { key: 'openrouter', name: 'OpenRouter', logo: '/img/OpenRouter.png', color: 'cyan' },
              { key: 'ollama', name: 'Ollama', logo: '/img/Ollama.png', color: 'purple' },
              { key: 'anthropic', name: 'Anthropic', logo: '/img/claude-logo.svg', color: 'orange' },
              { key: 'grok', name: 'Grok', logo: '/img/Grok.png', color: 'yellow' }
            ]
              .filter(provider =>
                activeSelection === 'chat' || EMBEDDING_CAPABLE_PROVIDERS.includes(provider.key as ProviderKey)
              )
              .map(provider => (
              <button
                key={provider.key}
                type="button"
                onClick={() => {
                  const providerKey = provider.key as ProviderKey;

                  if (activeSelection === 'chat') {
                    setChatProvider(providerKey);
                    // Update chat model when switching providers
                    const savedModels = providerModels[providerKey] || getDefaultModels(providerKey);
                    setRagSettings(prev => ({
                      ...prev,
                      MODEL_CHOICE: savedModels.chatModel
                    }));
                  } else {
                    setEmbeddingProvider(providerKey);
                    // Update embedding model when switching providers
                    const savedModels = providerModels[providerKey] || getDefaultModels(providerKey);
                    setRagSettings(prev => ({
                      ...prev,
                      EMBEDDING_MODEL: savedModels.embeddingModel
                    }));
                  }
                }}
                className={`
                  relative p-3 rounded-lg border-2 transition-all duration-200 text-center
                  ${(activeSelection === 'chat' ? chatProvider === provider.key : embeddingProvider === provider.key)
                    ? `${colorStyles[provider.key as ProviderKey]} shadow-[0_0_15px_rgba(34,197,94,0.3)]`
                    : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                  }
                  hover:scale-105 active:scale-95
                `}
              >
                <img
                  src={provider.logo}
                  alt={`${provider.name} logo`}
                  className={`w-8 h-8 mb-1 mx-auto ${
                    provider.key === 'openai' || provider.key === 'grok'
                      ? 'bg-white rounded p-1'
                      : ''
                  }`}
                />
                <div className={`font-medium text-gray-700 dark:text-gray-300 text-center ${
                  provider.key === 'openrouter' ? 'text-xs' : 'text-sm'
                }`}>
                  {provider.name}
                </div>
                {(() => {
                  const status = getProviderStatus(provider.key);

                  if (status === 'configured') {
                    return (
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    );
                  } else if (status === 'partial') {
                    return (
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-yellow-500 rounded-full flex items-center justify-center">
                        <div className="w-2 h-2 bg-white rounded-full" />
                      </div>
                    );
                  } else {
                    return (
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 bg-white rounded-full" />
                      </div>
                    );
                  }
                })()}
              </button>
            ))}
          </div>
          {shouldShowProviderAlert && (
            <div className={`p-4 border rounded-lg mb-4 ${providerAlertClassName}`}>
              <p className="text-sm">{providerAlertMessage}</p>
            </div>
          )}
          
          <div className="flex justify-between items-end">
            {/* Context-Aware Model Input */}
            <div className="flex-1 max-w-md">
              {activeSelection === 'chat' ? (
                chatProvider !== 'ollama' ? (
                  <Input
                    label="Chat Model"
                    value={getDisplayedChatModel(ragSettings)}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      MODEL_CHOICE: e.target.value
                    })}
                    placeholder={getModelPlaceholder(chatProvider)}
                    accentColor="green"
                  />
                ) : (
                  <div className="p-3 border border-green-500/30 rounded-lg bg-green-500/5">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Chat Model
                    </label>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Configured via Ollama instance
                    </div>
                    <div className="text-xs text-green-400 mt-1">
                      Current: {getDisplayedChatModel(ragSettings) || 'Not selected'}
                    </div>
                  </div>
                )
              ) : (
                embeddingProvider !== 'ollama' ? (
                  <Input
                    label="Embedding Model"
                    value={getDisplayedEmbeddingModel(ragSettings)}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      EMBEDDING_MODEL: e.target.value
                    })}
                    placeholder={getEmbeddingPlaceholder(embeddingProvider)}
                    accentColor="purple"
                  />
                ) : (
                  <div className="p-3 border border-purple-500/30 rounded-lg bg-purple-500/5">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Embedding Model
                    </label>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Configured via Ollama instance
                    </div>
                    <div className="text-xs text-purple-400 mt-1">
                      Current: {getDisplayedEmbeddingModel(ragSettings) || 'Not selected'}
                    </div>
                  </div>
                )
              )}
            </div>

            {/* Ollama Configuration Gear Icon */}
            {((activeSelection === 'chat' && chatProvider === 'ollama') ||
              (activeSelection === 'embedding' && embeddingProvider === 'ollama')) && (
              <Button
                variant="outline"
                accentColor="green"
                icon={<Cog className={`w-4 h-4 mr-1 transition-transform ${showOllamaConfig ? 'rotate-90' : ''}`} />}
                className="whitespace-nowrap ml-4 border-green-500 text-green-400 hover:bg-green-500/10"
                onClick={() => setShowOllamaConfig(!showOllamaConfig)}
              >
                {activeSelection === 'chat' ? 'Config' : 'Config'}
              </Button>
            )}

            {/* Save Settings Button */}
            <Button
              variant="outline"
              accentColor="green"
              icon={saving ? <Loader className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
              className="whitespace-nowrap ml-4"
              size="md"
              onClick={async () => {
                try {
                  setSaving(true);

                  // Ensure instance configurations are synced with ragSettings before saving
                  const updatedSettings = {
                    ...ragSettings,
                    LLM_BASE_URL: llmInstanceConfig.url,
                    LLM_INSTANCE_NAME: llmInstanceConfig.name,
                    OLLAMA_EMBEDDING_URL: embeddingInstanceConfig.url,
                    OLLAMA_EMBEDDING_INSTANCE_NAME: embeddingInstanceConfig.name
                  };

                  await credentialsService.updateRagSettings(updatedSettings);

                  // Update local ragSettings state to match what was saved
                  setRagSettings(updatedSettings);

                  showToast('RAG settings saved successfully!', 'success');
                } catch (err) {
                  console.error('Failed to save RAG settings:', err);
                  showToast('Failed to save settings', 'error');
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>

          {/* Expandable Ollama Configuration Container */}
          {showOllamaConfig && ((activeSelection === 'chat' && chatProvider === 'ollama') ||
                               (activeSelection === 'embedding' && embeddingProvider === 'ollama')) && (
            <div className="mt-4 p-4 bg-gradient-to-r from-green-500/5 to-green-600/5 border border-green-500/20 rounded-lg shadow-[0_2px_8px_rgba(34,197,94,0.1)]">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-white text-lg font-semibold">
                    {activeSelection === 'chat' ? 'LLM Chat Configuration' : 'Embedding Configuration'}
                  </h3>
                  <p className="text-gray-400 text-sm">
                    {activeSelection === 'chat'
                      ? 'Configure Ollama instance for chat completions'
                      : 'Configure Ollama instance for text embeddings'}
                  </p>
                </div>
                <div className={`text-sm font-medium ${
                  (activeSelection === 'chat' ? llmStatus.online : embeddingStatus.online)
                    ? "text-teal-400" : "text-red-400"
                }`}>
                  {(activeSelection === 'chat' ? llmStatus.online : embeddingStatus.online)
                    ? "Online" : "Offline"}
                </div>
              </div>

              {/* Configuration Content */}
              <div className="bg-black/40 rounded-lg p-4 shadow-[0_2px_8px_rgba(34,197,94,0.1)]">
                {activeSelection === 'chat' ? (
                  // Chat Model Configuration
                  <div>
                    {llmInstanceConfig.name && llmInstanceConfig.url ? (
                      <>
                        <div className="mb-3">
                          <div className="text-white font-medium mb-1">{llmInstanceConfig.name}</div>
                          <div className="text-gray-400 text-sm font-mono">{llmInstanceConfig.url}</div>
                        </div>

                        <div className="mb-4">
                          <div className="text-gray-300 text-sm mb-1">Model:</div>
                          <div className="text-white">{getDisplayedChatModel(ragSettings)}</div>
                        </div>

                        <div className="text-gray-400 text-sm mb-4">
                          {llmStatus.checking ? (
                            <Loader className="w-4 h-4 animate-spin inline mr-1" />
                          ) : null}
                          {ollamaMetrics.loading ? 'Loading...' : `${ollamaMetrics.llmInstanceModels?.chat || 0} chat models available`}
                        </div>

                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            accentColor="green"
                            className="text-white border-emerald-400 hover:bg-emerald-500/10"
                            onClick={() => setShowEditLLMModal(true)}
                          >
                            Edit Settings
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            accentColor="green"
                            className="text-white border-emerald-400 hover:bg-emerald-500/10"
                            onClick={async () => {
                              const success = await manualTestConnection(
                                llmInstanceConfig.url,
                                setLLMStatus,
                                llmInstanceConfig.name,
                                'chat'
                              );

                              setOllamaManualConfirmed(success);
                              setOllamaServerStatus(success ? 'online' : 'offline');
                            }}
                            disabled={llmStatus.checking}
                          >
                            {llmStatus.checking ? 'Testing...' : 'Test Connection'}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            accentColor="green"
                            className="text-white border-emerald-400 hover:bg-emerald-500/10"
                            onClick={() => setShowLLMModelSelectionModal(true)}
                          >
                            Select Model
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <div className="text-gray-400 text-sm mb-2">No LLM instance configured</div>
                        <div className="text-gray-500 text-xs mb-4">Configure an instance to use LLM chat features</div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-green-400 border-green-400 hover:bg-green-400/10"
                          onClick={() => setShowEditLLMModal(true)}
                        >
                          Add LLM Instance
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  // Embedding Model Configuration
                  <div>
                    {embeddingInstanceConfig.name && embeddingInstanceConfig.url ? (
                      <>
                        <div className="mb-3">
                          <div className="text-white font-medium mb-1">{embeddingInstanceConfig.name}</div>
                          <div className="text-gray-400 text-sm font-mono">{embeddingInstanceConfig.url}</div>
                        </div>

                        <div className="mb-4">
                          <div className="text-gray-300 text-sm mb-1">Model:</div>
                          <div className="text-white">{getDisplayedEmbeddingModel(ragSettings)}</div>
                        </div>

                        <div className="text-gray-400 text-sm mb-4">
                          {embeddingStatus.checking ? (
                            <Loader className="w-4 h-4 animate-spin inline mr-1" />
                          ) : null}
                          {ollamaMetrics.loading ? 'Loading...' : `${ollamaMetrics.embeddingInstanceModels?.embedding || 0} embedding models available`}
                        </div>

                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-purple-300 border-purple-400 hover:bg-purple-500/10"
                            onClick={() => setShowEditEmbeddingModal(true)}
                          >
                            Edit Settings
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-purple-300 border-purple-400 hover:bg-purple-500/10"
                            onClick={async () => {
                              const success = await manualTestConnection(
                                embeddingInstanceConfig.url,
                                setEmbeddingStatus,
                                embeddingInstanceConfig.name,
                                'embedding'
                              );

                              setOllamaManualConfirmed(success);
                              setOllamaServerStatus(success ? 'online' : 'offline');
                            }}
                            disabled={embeddingStatus.checking}
                          >
                            {embeddingStatus.checking ? 'Testing...' : 'Test Connection'}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-purple-300 border-purple-400 hover:bg-purple-500/10"
                            onClick={() => setShowEmbeddingModelSelectionModal(true)}
                          >
                            Select Model
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <div className="text-gray-400 text-sm mb-2">No Embedding instance configured</div>
                        <div className="text-gray-500 text-xs mb-4">Configure an instance to use embedding features</div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-purple-300 border-purple-400 hover:bg-purple-500/10"
                          onClick={() => setShowEditEmbeddingModal(true)}
                        >
                          Add Embedding Instance
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Context-Aware Configuration Summary */}
              <div className="bg-black/40 rounded-lg p-4 mt-4 shadow-[0_2px_8px_rgba(34,197,94,0.1)]">
                <h4 className="text-white font-medium mb-3">
                  {activeSelection === 'chat' ? 'LLM Instance Summary' : 'Embedding Instance Summary'}
                </h4>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-600">
                        <th className="text-left py-2 text-gray-300 font-medium">Configuration</th>
                        <th className="text-left py-2 text-gray-300 font-medium">
                          {activeSelection === 'chat' ? 'LLM Instance' : 'Embedding Instance'}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-600">
                      <tr>
                        <td className="py-2 text-gray-400">Instance Name</td>
                        <td className="py-2 text-white">
                          {activeSelection === 'chat'
                            ? (llmInstanceConfig.name || <span className="text-gray-500 italic">Not configured</span>)
                            : (embeddingInstanceConfig.name || <span className="text-gray-500 italic">Not configured</span>)
                          }
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 text-gray-400">Instance URL</td>
                        <td className="py-2 text-white font-mono text-xs">
                          {activeSelection === 'chat'
                            ? (llmInstanceConfig.url || <span className="text-gray-500 italic">Not configured</span>)
                            : (embeddingInstanceConfig.url || <span className="text-gray-500 italic">Not configured</span>)
                          }
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 text-gray-400">Status</td>
                        <td className="py-2">
                          {activeSelection === 'chat' ? (
                            <span className={llmStatus.checking ? "text-yellow-400" : llmStatus.online ? "text-teal-400" : "text-red-400"}>
                              {llmStatus.checking ? "Checking..." : llmStatus.online ? `Online (${llmStatus.responseTime}ms)` : "Offline"}
                            </span>
                          ) : (
                            <span className={embeddingStatus.checking ? "text-yellow-400" : embeddingStatus.online ? "text-teal-400" : "text-red-400"}>
                              {embeddingStatus.checking ? "Checking..." : embeddingStatus.online ? `Online (${embeddingStatus.responseTime}ms)` : "Offline"}
                            </span>
                          )}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 text-gray-400">Selected Model</td>
                        <td className="py-2 text-white">
                          {activeSelection === 'chat'
                            ? (getDisplayedChatModel(ragSettings) || <span className="text-gray-500 italic">No model selected</span>)
                            : (getDisplayedEmbeddingModel(ragSettings) || <span className="text-gray-500 italic">No model selected</span>)
                          }
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 text-gray-400">Available Models</td>
                        <td className="py-2">
                          {ollamaMetrics.loading ? (
                            <Loader className="w-3 h-3 animate-spin inline" />
                          ) : activeSelection === 'chat' ? (
                            <div className="text-white">
                              <span className="text-green-400 font-medium text-lg">{ollamaMetrics.llmInstanceModels?.chat || 0}</span>
                              <span className="text-gray-400 text-sm ml-2">chat models</span>
                            </div>
                          ) : (
                            <div className="text-white">
                              <span className="text-purple-400 font-medium text-lg">{ollamaMetrics.embeddingInstanceModels?.embedding || 0}</span>
                              <span className="text-gray-400 text-sm ml-2">embedding models</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {/* Instance-Specific Readiness */}
                  <div className="mt-4 pt-3 border-t border-gray-600">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">
                        {activeSelection === 'chat' ? 'LLM Instance Status:' : 'Embedding Instance Status:'}
                      </span>
                      <span className={
                        activeSelection === 'chat'
                          ? (llmStatus.online ? "text-teal-400 font-medium" : "text-red-400")
                          : (embeddingStatus.online ? "text-teal-400 font-medium" : "text-red-400")
                      }>
                        {activeSelection === 'chat'
                          ? (llmStatus.online ? "✓ Ready" : "✗ Not Ready")
                          : (embeddingStatus.online ? "✓ Ready" : "✗ Not Ready")
                        }
                      </span>
                    </div>

                    {/* Instance-Specific Model Metrics */}
                    <div className="mt-3 flex items-center gap-4 text-xs text-gray-400">
                      <div className="flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
                        </svg>
                        <span>Available on this instance:</span>
                        <span className="text-white">
                          {ollamaMetrics.loading ? (
                            <Loader className="w-3 h-3 animate-spin inline" />
                          ) : activeSelection === 'chat' ? (
                            `${ollamaMetrics.llmInstanceModels?.chat || 0} chat models`
                          ) : (
                            `${ollamaMetrics.embeddingInstanceModels?.embedding || 0} embedding models`
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>


        {/* Second row: Contextual Embeddings, Max Workers, and description */}
        <div className="grid grid-cols-8 gap-4 mb-4 p-4 rounded-lg border border-green-500/20 shadow-[0_2px_8px_rgba(34,197,94,0.1)]">
          <div className="col-span-4">
            <CustomCheckbox 
              id="contextualEmbeddings" 
              checked={ragSettings.USE_CONTEXTUAL_EMBEDDINGS} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_CONTEXTUAL_EMBEDDINGS: e.target.checked
              })} 
              label="Use Contextual Embeddings" 
              description="Enhances embeddings with contextual information for better retrieval" 
            />
          </div>
                      <div className="col-span-1">
              {ragSettings.USE_CONTEXTUAL_EMBEDDINGS && (
                <div className="flex flex-col items-center">
                  <div className="relative ml-2 mr-6">
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={ragSettings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS}
                      onChange={e => setRagSettings({
                        ...ragSettings,
                        CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: parseInt(e.target.value, 10) || 3
                      })}
                      className="w-14 h-10 pl-1 pr-7 text-center font-medium rounded-md 
                        bg-gradient-to-b from-gray-100 to-gray-200 dark:from-gray-900 dark:to-black 
                        border border-green-500/30 
                        text-gray-900 dark:text-white
                        focus:border-green-500 focus:shadow-[0_0_15px_rgba(34,197,94,0.4)]
                        transition-all duration-200
                        [appearance:textfield] 
                        [&::-webkit-outer-spin-button]:appearance-none 
                        [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <div className="absolute right-1 top-1 bottom-1 flex flex-col">
                      <button
                        type="button"
                        onClick={() => setRagSettings({
                          ...ragSettings,
                          CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: Math.min(ragSettings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS + 1, 10)
                        })}
                        className="flex-1 px-1 rounded-t-sm 
                          bg-gradient-to-b from-green-500/20 to-green-600/10
                          hover:from-green-500/30 hover:to-green-600/20
                          border border-green-500/30 border-b-0
                          transition-all duration-200 group"
                      >
                        <svg className="w-2.5 h-2.5 text-green-500 group-hover:filter group-hover:drop-shadow-[0_0_4px_rgba(34,197,94,0.8)]" 
                          viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 5L5 1L9 5" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => setRagSettings({
                          ...ragSettings,
                          CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: Math.max(ragSettings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS - 1, 1)
                        })}
                        className="flex-1 px-1 rounded-b-sm 
                          bg-gradient-to-b from-green-500/20 to-green-600/10
                          hover:from-green-500/30 hover:to-green-600/20
                          border border-green-500/30 border-t-0
                          transition-all duration-200 group"
                      >
                        <svg className="w-2.5 h-2.5 text-green-500 group-hover:filter group-hover:drop-shadow-[0_0_4px_rgba(34,197,94,0.8)]" 
                          viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 1L5 5L9 1" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Max
                  </label>
                </div>
              )}
            </div>
          <div className="col-span-3">
            {ragSettings.USE_CONTEXTUAL_EMBEDDINGS && (
              <p className="text-xs text-green-900 dark:text-blue-600 mt-2">
                Controls parallel processing for embeddings (1-10)
              </p>
            )}
          </div>
        </div>
        
        {/* Third row: Hybrid Search and Agentic RAG */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <CustomCheckbox 
              id="hybridSearch" 
              checked={ragSettings.USE_HYBRID_SEARCH} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_HYBRID_SEARCH: e.target.checked
              })} 
              label="Use Hybrid Search" 
              description="Combines vector similarity search with keyword search for better results" 
            />
          </div>
          <div>
            <CustomCheckbox 
              id="agenticRag" 
              checked={ragSettings.USE_AGENTIC_RAG} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_AGENTIC_RAG: e.target.checked
              })} 
              label="Use Agentic RAG" 
              description="Enables code extraction and specialized search for technical content" 
            />
          </div>
        </div>
        
        {/* Fourth row: Use Reranking */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <CustomCheckbox 
              id="reranking" 
              checked={ragSettings.USE_RERANKING} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_RERANKING: e.target.checked
              })} 
              label="Use Reranking" 
              description="Applies cross-encoder reranking to improve search result relevance" 
            />
          </div>
          <div>{/* Empty column */}</div>
        </div>

        {/* Crawling Performance Settings */}
        <div className="mt-6">
          <div
            className="flex items-center justify-between cursor-pointer p-3 rounded-lg border border-green-500/20 bg-gradient-to-r from-green-500/5 to-green-600/5 hover:from-green-500/10 hover:to-green-600/10 transition-all duration-200"
            onClick={() => setShowCrawlingSettings(!showCrawlingSettings)}
          >
            <div className="flex items-center">
              <Zap className="mr-2 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" size={18} />
              <h3 className="font-semibold text-gray-800 dark:text-white">Crawling Performance Settings</h3>
            </div>
            {showCrawlingSettings ? (
              <ChevronUp className="text-gray-500 dark:text-gray-400" size={20} />
            ) : (
              <ChevronDown className="text-gray-500 dark:text-gray-400" size={20} />
            )}
          </div>
          
          {showCrawlingSettings && (
            <div className="mt-4 p-4 border border-green-500/10 rounded-lg bg-green-500/5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Batch Size
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="100"
                    value={ragSettings.CRAWL_BATCH_SIZE || 50}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_BATCH_SIZE: parseInt(e.target.value, 10) || 50
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">URLs to crawl in parallel (10-100)</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Max Concurrent
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={ragSettings.CRAWL_MAX_CONCURRENT || 10}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_MAX_CONCURRENT: parseInt(e.target.value, 10) || 10
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Pages to crawl in parallel per operation (1-20)</p>
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4 mt-4">
                <div>
                  <Select
                    label="Wait Strategy"
                    value={ragSettings.CRAWL_WAIT_STRATEGY || 'domcontentloaded'}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_WAIT_STRATEGY: e.target.value
                    })}
                    accentColor="green"
                    options={[
                      { value: 'domcontentloaded', label: 'DOM Loaded (Fast)' },
                      { value: 'networkidle', label: 'Network Idle (Thorough)' },
                      { value: 'load', label: 'Full Load (Slowest)' }
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Page Timeout (sec)
                  </label>
                  <input
                    type="number"
                    min="5"
                    max="120"
                    value={(ragSettings.CRAWL_PAGE_TIMEOUT || 60000) / 1000}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_PAGE_TIMEOUT: (parseInt(e.target.value, 10) || 60) * 1000
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Render Delay (sec)
                  </label>
                  <input
                    type="number"
                    min="0.1"
                    max="5"
                    step="0.1"
                    value={ragSettings.CRAWL_DELAY_BEFORE_HTML || 0.5}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_DELAY_BEFORE_HTML: parseFloat(e.target.value) || 0.5
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Storage Performance Settings */}
        <div className="mt-4">
          <div
            className="flex items-center justify-between cursor-pointer p-3 rounded-lg border border-green-500/20 bg-gradient-to-r from-green-500/5 to-green-600/5 hover:from-green-500/10 hover:to-green-600/10 transition-all duration-200"
            onClick={() => setShowStorageSettings(!showStorageSettings)}
          >
            <div className="flex items-center">
              <Database className="mr-2 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" size={18} />
              <h3 className="font-semibold text-gray-800 dark:text-white">Storage Performance Settings</h3>
            </div>
            {showStorageSettings ? (
              <ChevronUp className="text-gray-500 dark:text-gray-400" size={20} />
            ) : (
              <ChevronDown className="text-gray-500 dark:text-gray-400" size={20} />
            )}
          </div>
          
          {showStorageSettings && (
            <div className="mt-4 p-4 border border-green-500/10 rounded-lg bg-green-500/5">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Document Batch Size
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="100"
                    value={ragSettings.DOCUMENT_STORAGE_BATCH_SIZE || 50}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      DOCUMENT_STORAGE_BATCH_SIZE: parseInt(e.target.value, 10) || 50
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Chunks per batch (10-100)</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Embedding Batch Size
                  </label>
                  <input
                    type="number"
                    min="20"
                    max="200"
                    value={ragSettings.EMBEDDING_BATCH_SIZE || 100}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      EMBEDDING_BATCH_SIZE: parseInt(e.target.value, 10) || 100
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Per API call (20-200)</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Code Extraction Workers
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={ragSettings.CODE_SUMMARY_MAX_WORKERS || 3}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CODE_SUMMARY_MAX_WORKERS: parseInt(e.target.value, 10) || 3
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Parallel workers (1-10)</p>
                </div>
              </div>
              
              <div className="mt-4 flex items-center">
                <CustomCheckbox
                  id="parallelBatches"
                  checked={ragSettings.ENABLE_PARALLEL_BATCHES !== false}
                  onChange={e => setRagSettings({
                    ...ragSettings,
                    ENABLE_PARALLEL_BATCHES: e.target.checked
                  })}
                  label="Enable Parallel Processing"
                  description="Process multiple document batches simultaneously for faster storage"
                />
              </div>
            </div>
          )}
        </div>

        {/* Edit LLM Instance Modal */}
        {showEditLLMModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center pt-20 z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 max-w-md">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Edit LLM Instance</h3>
              
              <div className="space-y-4">
                <Input
                  label="Instance Name"
                  value={llmInstanceConfig.name}
                  onChange={(e) => {
                    const newName = e.target.value;
                    setLLMInstanceConfig({...llmInstanceConfig, name: newName});
                    
                    // Auto-sync embedding instance name if URLs are the same (single host setup)
                    if (llmInstanceConfig.url === embeddingInstanceConfig.url && embeddingInstanceConfig.url !== '') {
                      setEmbeddingInstanceConfig({...embeddingInstanceConfig, name: newName});
                    }
                  }}
                  placeholder="Enter instance name"
                />
                
                <Input
                  label="Instance URL"
                  value={llmInstanceConfig.url}
                  onChange={(e) => {
                    const newUrl = e.target.value;
                    setLLMInstanceConfig({...llmInstanceConfig, url: newUrl});
                    
                    // Auto-populate embedding instance if it's empty (convenience for single-host users)
                    if (!embeddingInstanceConfig.url || !embeddingInstanceConfig.name) {
                      setEmbeddingInstanceConfig({
                        name: llmInstanceConfig.name || 'Default Ollama',
                        url: newUrl
                      });
                    }
                  }}
                  placeholder="http://host.docker.internal:11434/v1"
                />
                
                {/* Convenience checkbox for single host setup */}
                <div className="flex items-center gap-2 mt-3">
                  <input
                    type="checkbox"
                    id="use-same-host"
                    checked={llmInstanceConfig.url === embeddingInstanceConfig.url && llmInstanceConfig.url !== ''}
                    onChange={(e) => {
                      if (e.target.checked) {
                        // Sync embedding instance with LLM instance
                        setEmbeddingInstanceConfig({
                          name: llmInstanceConfig.name || 'Default Ollama',
                          url: llmInstanceConfig.url
                        });
                      }
                    }}
                    className="w-4 h-4 text-purple-600 bg-gray-100 border-gray-300 rounded focus:ring-purple-500 dark:focus:ring-purple-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                  />
                  <label htmlFor="use-same-host" className="text-sm text-gray-600 dark:text-gray-400">
                    Use same host for embedding instance
                  </label>
                </div>
              </div>
              
              <div className="flex gap-2 mt-6">
                <Button
                  variant="outline"
                  onClick={() => setShowEditLLMModal(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    setRagSettings({...ragSettings, LLM_BASE_URL: llmInstanceConfig.url});
                    setShowEditLLMModal(false);
                    showToast('LLM instance updated successfully', 'success');
                    // Wait 1 second then automatically test connection and refresh models
                    setTimeout(() => {
                      manualTestConnection(
                        llmInstanceConfig.url,
                        setLLMStatus,
                        llmInstanceConfig.name,
                        'chat',
                        { suppressToast: true }
                      ).then((success) => {
                        setOllamaManualConfirmed(success);
                        setOllamaServerStatus(success ? 'online' : 'offline');
                      });
                      fetchOllamaMetrics(); // Refresh model metrics after saving
                    }, 1000);
                  }}
                  className="flex-1"
                  accentColor="green"
                >
                  Save Changes
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Edit Embedding Instance Modal */}
        {showEditEmbeddingModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center pt-20 z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 max-w-md">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Edit Embedding Instance</h3>
              
              <div className="space-y-4">
                <Input
                  label="Instance Name"
                  value={embeddingInstanceConfig.name}
                  onChange={(e) => setEmbeddingInstanceConfig({...embeddingInstanceConfig, name: e.target.value})}
                  placeholder="Enter instance name"
                />
                
                <Input
                  label="Instance URL"
                  value={embeddingInstanceConfig.url}
                  onChange={(e) => setEmbeddingInstanceConfig({...embeddingInstanceConfig, url: e.target.value})}
                  placeholder="http://host.docker.internal:11434/v1"
                />
              </div>
              
              <div className="flex gap-2 mt-6">
                <Button
                  variant="outline"
                  onClick={() => setShowEditEmbeddingModal(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    setRagSettings({...ragSettings, OLLAMA_EMBEDDING_URL: embeddingInstanceConfig.url});
                    setShowEditEmbeddingModal(false);
                    showToast('Embedding instance updated successfully', 'success');
                    // Wait 1 second then automatically test connection and refresh models
                    setTimeout(() => {
                      manualTestConnection(
                        embeddingInstanceConfig.url,
                        setEmbeddingStatus,
                        embeddingInstanceConfig.name,
                        'embedding',
                        { suppressToast: true }
                      ).then((success) => {
                        setOllamaManualConfirmed(success);
                        setOllamaServerStatus(success ? 'online' : 'offline');
                      });
                      fetchOllamaMetrics(); // Refresh model metrics after saving
                    }, 1000);
                  }}
                  className="flex-1"
                  accentColor="green"
                >
                  Save Changes
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* LLM Model Selection Modal */}
        {showLLMModelSelectionModal && (
          <OllamaModelSelectionModal
            isOpen={showLLMModelSelectionModal}
            onClose={() => setShowLLMModelSelectionModal(false)}
            instances={[
              { name: llmInstanceConfig.name, url: llmInstanceConfig.url },
              { name: embeddingInstanceConfig.name, url: embeddingInstanceConfig.url }
            ]}
            currentModel={ragSettings.MODEL_CHOICE}
            modelType="chat"
            selectedInstanceUrl={normalizeBaseUrl(llmInstanceConfig.url) ?? ''}
            onSelectModel={(modelName: string) => {
              setRagSettings({ ...ragSettings, MODEL_CHOICE: modelName });
              showToast(`Selected LLM model: ${modelName}`, 'success');
            }}
          />
        )}

        {/* Embedding Model Selection Modal */}
        {showEmbeddingModelSelectionModal && (
          <OllamaModelSelectionModal
            isOpen={showEmbeddingModelSelectionModal}
            onClose={() => setShowEmbeddingModelSelectionModal(false)}
            instances={[
              { name: llmInstanceConfig.name, url: llmInstanceConfig.url },
              { name: embeddingInstanceConfig.name, url: embeddingInstanceConfig.url }
            ]}
            currentModel={ragSettings.EMBEDDING_MODEL}
            modelType="embedding"
            selectedInstanceUrl={normalizeBaseUrl(embeddingInstanceConfig.url) ?? ''}
            onSelectModel={(modelName: string) => {
              setRagSettings({ ...ragSettings, EMBEDDING_MODEL: modelName });
              showToast(`Selected embedding model: ${modelName}`, 'success');
            }}
          />
        )}

        {/* Ollama Model Discovery Modal */}
        {showModelDiscoveryModal && (
          <OllamaModelDiscoveryModal
            isOpen={showModelDiscoveryModal}
            onClose={() => setShowModelDiscoveryModal(false)}
            instances={[]}
            onSelectModels={(selection: { chatModel?: string; embeddingModel?: string }) => {
              const updatedSettings = { ...ragSettings };
              if (selection.chatModel) {
                updatedSettings.MODEL_CHOICE = selection.chatModel;
              }
              if (selection.embeddingModel) {
                updatedSettings.EMBEDDING_MODEL = selection.embeddingModel;
              }
              setRagSettings(updatedSettings);
              setShowModelDiscoveryModal(false);
              // Refresh metrics after model discovery
              fetchOllamaMetrics();
              showToast(`Selected models: ${selection.chatModel || 'none'} (chat), ${selection.embeddingModel || 'none'} (embedding)`, 'success');
            }}
          />
        )}
    </Card>;
};

// Helper functions to get provider-specific model display
function getDisplayedChatModel(ragSettings: RAGSettingsProps["ragSettings"]): string {
  const provider = ragSettings.LLM_PROVIDER || 'openai';
  const modelChoice = ragSettings.MODEL_CHOICE;

  // Always prioritize user input to allow editing
  if (modelChoice !== undefined && modelChoice !== null) {
    return modelChoice;
  }

  // Only use defaults when there's no stored value
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'google':
      return 'gemini-1.5-flash';
    case 'grok':
      return 'grok-3-mini';
    case 'ollama':
      return '';
    case 'openrouter':
      return 'anthropic/claude-3.5-sonnet';
    default:
      return 'gpt-4o-mini';
  }
}

function getDisplayedEmbeddingModel(ragSettings: RAGSettingsProps["ragSettings"]): string {
  const provider = ragSettings.EMBEDDING_PROVIDER || ragSettings.LLM_PROVIDER || 'openai';
  const embeddingModel = ragSettings.EMBEDDING_MODEL;

  // Always prioritize user input to allow editing
  if (embeddingModel !== undefined && embeddingModel !== null && embeddingModel !== '') {
    return embeddingModel;
  }

  // Provide appropriate defaults based on LLM provider
  switch (provider) {
    case 'openai':
      return 'text-embedding-3-small';
    case 'google':
      return 'text-embedding-004';
    case 'ollama':
      return '';
    case 'openrouter':
      return 'text-embedding-3-small';  // Default to OpenAI embedding for OpenRouter
    case 'anthropic':
      return 'text-embedding-3-small';  // Use OpenAI embeddings with Claude
    case 'grok':
      return 'text-embedding-3-small';  // Use OpenAI embeddings with Grok
    default:
      return 'text-embedding-3-small';
  }
}

// Helper functions for model placeholders
function getModelPlaceholder(provider: ProviderKey): string {
  switch (provider) {
    case 'openai':
      return 'e.g., gpt-4o-mini';
    case 'anthropic':
      return 'e.g., claude-3-5-sonnet-20241022';
    case 'google':
      return 'e.g., gemini-1.5-flash';
    case 'grok':
      return 'e.g., grok-2-latest';
    case 'ollama':
      return 'e.g., llama2, mistral';
    case 'openrouter':
      return 'e.g., anthropic/claude-3.5-sonnet';
    default:
      return 'e.g., gpt-4o-mini';
  }
}

function getEmbeddingPlaceholder(provider: ProviderKey): string {
  switch (provider) {
    case 'openai':
      return 'Default: text-embedding-3-small';
    case 'anthropic':
      return 'Claude does not provide embedding models';
    case 'google':
      return 'e.g., text-embedding-004';
    case 'grok':
      return 'Grok does not provide embedding models';
    case 'ollama':
      return 'e.g., nomic-embed-text';
    case 'openrouter':
      return 'e.g., text-embedding-3-small';
    default:
      return 'Default: text-embedding-3-small';
  }
}

interface CustomCheckboxProps {
  id: string;
  checked: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  description: string;
}

const CustomCheckbox = ({
  id,
  checked,
  onChange,
  label,
  description
}: CustomCheckboxProps) => {
  return (
    <div className="flex items-start group">
      <div className="relative flex items-center h-5 mt-1">
        <input 
          type="checkbox" 
          id={id} 
          checked={checked} 
          onChange={onChange} 
          className="sr-only peer" 
        />
        <label 
          htmlFor={id}
          className="relative w-5 h-5 rounded-md transition-all duration-200 cursor-pointer
            bg-gradient-to-b from-white/80 to-white/60 dark:from-white/5 dark:to-black/40
            border border-gray-300 dark:border-gray-700
            peer-checked:border-green-500 dark:peer-checked:border-green-500/50
            peer-checked:bg-gradient-to-b peer-checked:from-green-500/20 peer-checked:to-green-600/20
            group-hover:border-green-500/50 dark:group-hover:border-green-500/30
            peer-checked:shadow-[0_0_10px_rgba(34,197,94,0.2)] dark:peer-checked:shadow-[0_0_15px_rgba(34,197,94,0.3)]"
        >
          <Check className={`
              w-3.5 h-3.5 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
              transition-all duration-200 text-green-500 pointer-events-none
              ${checked ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}
            `} />
        </label>
      </div>
      <div className="ml-3 flex-1">
        <label htmlFor={id} className="text-gray-700 dark:text-zinc-300 font-medium cursor-pointer block text-sm">
          {label}
        </label>
        <p className="text-xs text-gray-600 dark:text-zinc-400 mt-0.5 leading-tight">
          {description}
        </p>
      </div>
    </div>
  );
};
