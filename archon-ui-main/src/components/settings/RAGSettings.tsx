import React, { useState, useEffect, useRef } from 'react';
import { Settings, Check, Save, Loader, ChevronDown, ChevronUp, Zap, Database, Trash2 } from 'lucide-react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { useToast } from '../../features/ui/hooks/useToast';
import { credentialsService } from '../../services/credentialsService';
import OllamaModelDiscoveryModal from './OllamaModelDiscoveryModal';
import OllamaModelSelectionModal from './OllamaModelSelectionModal';

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
    EMBEDDING_MODEL?: string;
    OLLAMA_EMBEDDING_URL?: string;
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
  
  // Edit modals state
  const [showEditLLMModal, setShowEditLLMModal] = useState(false);
  const [showEditEmbeddingModal, setShowEditEmbeddingModal] = useState(false);
  
  // Model selection modals state
  const [showLLMModelSelectionModal, setShowLLMModelSelectionModal] = useState(false);
  const [showEmbeddingModelSelectionModal, setShowEmbeddingModelSelectionModal] = useState(false);
  
  // Instance configurations
  const [llmInstanceConfig, setLLMInstanceConfig] = useState({
    name: '',
    url: ragSettings.LLM_BASE_URL || 'http://localhost:11434/v1'
  });
  const [embeddingInstanceConfig, setEmbeddingInstanceConfig] = useState({
    name: '', 
    url: ragSettings.OLLAMA_EMBEDDING_URL || 'http://localhost:11434/v1'
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

  // Load API credentials for status checking
  useEffect(() => {
    const loadApiCredentials = async () => {
      try {
        // Get decrypted values for the API keys we need for status checking
        const keyNames = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'];
        const statusResults = await credentialsService.checkCredentialStatus(keyNames);
        
        const credentials: {[key: string]: string} = {};
        
        for (const [key, result] of Object.entries(statusResults)) {
          if (result.has_value && result.value && result.value.trim().length > 0) {
            credentials[key] = result.value;
          }
        }
        
        console.log('🔑 Loaded API credentials for status checking:', Object.keys(credentials));
        setApiCredentials(credentials);
      } catch (error) {
        console.error('Failed to load API credentials for status checking:', error);
      }
    };

    loadApiCredentials();
  }, []);

  // Reload API credentials when ragSettings change (e.g., after saving)
  // Use a ref to track if we've loaded credentials to prevent infinite loops
  const hasLoadedCredentialsRef = useRef(false);
  
  // Manual reload function for external calls
  const reloadApiCredentials = async () => {
    try {
      // Get decrypted values for the API keys we need for status checking
      const keyNames = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'];
      const statusResults = await credentialsService.checkCredentialStatus(keyNames);
      
      const credentials: {[key: string]: string} = {};
      
      for (const [key, result] of Object.entries(statusResults)) {
        if (result.has_value && result.value && result.value.trim().length > 0) {
          credentials[key] = result.value;
        }
      }
      
      console.log('🔄 Reloaded API credentials for status checking:', Object.keys(credentials));
      setApiCredentials(credentials);
      hasLoadedCredentialsRef.current = true;
    } catch (error) {
      console.error('Failed to reload API credentials:', error);
    }
  };
  
  useEffect(() => {
    // Only reload if we have ragSettings and haven't loaded yet, or if LLM_PROVIDER changed
    if (Object.keys(ragSettings).length > 0 && (!hasLoadedCredentialsRef.current || ragSettings.LLM_PROVIDER)) {
      reloadApiCredentials();
    }
  }, [ragSettings.LLM_PROVIDER]); // Only depend on LLM_PROVIDER changes
  
  // Reload credentials periodically to catch updates from other components (like onboarding)
  useEffect(() => {
    // Set up periodic reload every 30 seconds when component is active (reduced from 2s)
    const interval = setInterval(() => {
      if (Object.keys(ragSettings).length > 0) {
        reloadApiCredentials();
      }
    }, 30000); // Changed from 2000ms to 30000ms (30 seconds)

    return () => clearInterval(interval);
  }, [ragSettings.LLM_PROVIDER]); // Only restart interval if provider changes
  
  // Status tracking
  const [llmStatus, setLLMStatus] = useState({ online: false, responseTime: null, checking: false });
  const [embeddingStatus, setEmbeddingStatus] = useState({ online: false, responseTime: null, checking: false });
  
  // API key credentials for status checking
  const [apiCredentials, setApiCredentials] = useState<{[key: string]: string}>({});
  // Provider connection status tracking
  const [providerConnectionStatus, setProviderConnectionStatus] = useState<{
    [key: string]: { connected: boolean; checking: boolean; lastChecked?: Date }
  }>({});

  // Test connection to external providers
  const testProviderConnection = async (provider: string, apiKey: string): Promise<boolean> => {
    setProviderConnectionStatus(prev => ({
      ...prev,
      [provider]: { ...prev[provider], checking: true }
    }));

    try {
      switch (provider) {
        case 'openai':
          // Test OpenAI connection with a simple completion request
          const openaiResponse = await fetch('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            }
          });
          
          if (openaiResponse.ok) {
            setProviderConnectionStatus(prev => ({
              ...prev,
              openai: { connected: true, checking: false, lastChecked: new Date() }
            }));
            return true;
          } else {
            throw new Error(`OpenAI API returned ${openaiResponse.status}`);
          }

        case 'google':
          // Test Google Gemini connection 
          const googleResponse = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json'
            }
          });
          
          if (googleResponse.ok) {
            setProviderConnectionStatus(prev => ({
              ...prev,
              google: { connected: true, checking: false, lastChecked: new Date() }
            }));
            return true;
          } else {
            throw new Error(`Google API returned ${googleResponse.status}`);
          }

        default:
          return false;
      }
    } catch (error) {
      console.error(`Failed to test ${provider} connection:`, error);
      setProviderConnectionStatus(prev => ({
        ...prev,
        [provider]: { connected: false, checking: false, lastChecked: new Date() }
      }));
      return false;
    }
  };

  // Test provider connections when API credentials change
  useEffect(() => {
    const testConnections = async () => {
      const providers = ['openai', 'google'];
      
      for (const provider of providers) {
        const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'GOOGLE_API_KEY';
        const apiKey = Object.keys(apiCredentials).find(key => key.toUpperCase() === keyName);
        const keyValue = apiKey ? apiCredentials[apiKey] : undefined;
        
        if (keyValue && keyValue.trim().length > 0) {
          // Don't test if we've already checked recently (within last 30 seconds)
          const lastChecked = providerConnectionStatus[provider]?.lastChecked;
          const now = new Date();
          const timeSinceLastCheck = lastChecked ? now.getTime() - lastChecked.getTime() : Infinity;
          
          if (timeSinceLastCheck > 30000) { // 30 seconds
            console.log(`🔄 Testing ${provider} connection...`);
            await testProviderConnection(provider, keyValue);
          }
        } else {
          // No API key, mark as disconnected
          setProviderConnectionStatus(prev => ({
            ...prev,
            [provider]: { connected: false, checking: false, lastChecked: new Date() }
          }));
        }
      }
    };

    // Only test if we have credentials loaded
    if (Object.keys(apiCredentials).length > 0) {
      testConnections();
    }
  }, [apiCredentials]); // Test when credentials change

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
  const manualTestConnection = async (url: string, setStatus: React.Dispatch<React.SetStateAction<{ online: boolean; responseTime: number | null; checking: boolean }>>, instanceName: string) => {
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
          showToast(`${instanceName} connection successful: ${instanceStatus.models_available || 0} models available (${responseTime}ms)`, 'success');
          
          // Scenario 2: Manual "Test Connection" button - refresh Ollama metrics if Ollama provider is selected
          if (ragSettings.LLM_PROVIDER === 'ollama') {
            console.log('🔄 Fetching Ollama metrics - Test Connection button clicked');
            fetchOllamaMetrics();
          }
        } else {
          setStatus({ online: false, responseTime: null, checking: false });
          showToast(`${instanceName} connection failed: ${instanceStatus?.error_message || 'Instance is not healthy'}`, 'error');
        }
      } else {
        setStatus({ online: false, responseTime: null, checking: false });
        showToast(`${instanceName} connection failed: Backend proxy error (HTTP ${response.status})`, 'error');
      }
    } catch (error: any) {
      setStatus({ online: false, responseTime: null, checking: false });
      
      if (error.name === 'AbortError') {
        showToast(`${instanceName} connection failed: Request timeout (>15s)`, 'error');
      } else {
        showToast(`${instanceName} connection failed: ${error.message || 'Unknown error'}`, 'error');
      }
    }
  };;

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

      // Prepare instance URLs for the API call
      const instanceUrls = [];
      if (llmInstanceConfig.url) instanceUrls.push(llmInstanceConfig.url);
      if (embeddingInstanceConfig.url && embeddingInstanceConfig.url !== llmInstanceConfig.url) {
        instanceUrls.push(embeddingInstanceConfig.url);
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
          model.instance_url === llmInstanceConfig.url
        );
        const llmEmbeddingModels = allEmbeddingModels.filter((model: any) => 
          model.instance_url === llmInstanceConfig.url
        );
        
        // Count models for Embedding instance
        const embChatModels = allChatModels.filter((model: any) => 
          model.instance_url === embeddingInstanceConfig.url
        );
        const embEmbeddingModels = allEmbeddingModels.filter((model: any) => 
          model.instance_url === embeddingInstanceConfig.url
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
  const lastMetricsFetchRef = useRef({ provider: '', llmUrl: '', embUrl: '', llmOnline: false, embOnline: false });
  
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

  // Fetch Ollama metrics only when Ollama provider is initially selected (not on URL changes during typing)
  React.useEffect(() => {
    if (ragSettings.LLM_PROVIDER === 'ollama') {
      const currentProvider = ragSettings.LLM_PROVIDER;
      const lastProvider = lastMetricsFetchRef.current.provider;
      
      // Only fetch if provider changed to Ollama (scenario 1: user clicks on Ollama Provider)
      if (currentProvider !== lastProvider) {
        lastMetricsFetchRef.current = {
          provider: currentProvider,
          llmUrl: llmInstanceConfig.url,
          embUrl: embeddingInstanceConfig.url,
          llmOnline: llmStatus.online,
          embOnline: embeddingStatus.online
        };
        console.log('🔄 Fetching Ollama metrics - Provider selected');
        fetchOllamaMetrics();
      }
    }
  }, [ragSettings.LLM_PROVIDER]); // Only watch provider changes, not URL changes

  // Function to check if a provider is properly configured
  const getProviderStatus = (providerKey: string): 'configured' | 'missing' | 'partial' => {
    switch (providerKey) {
      case 'openai':
        // Check if OpenAI API key is configured (case insensitive)
        const openAIKey = Object.keys(apiCredentials).find(key => key.toUpperCase() === 'OPENAI_API_KEY');
        const keyValue = openAIKey ? apiCredentials[openAIKey] : undefined;
        // Don't consider encrypted placeholders as valid API keys for connection testing
        const hasOpenAIKey = openAIKey && keyValue && keyValue.trim().length > 0 && !keyValue.includes('[ENCRYPTED]');
        
        // Only show configured if we have both API key AND confirmed connection
        const openAIConnected = providerConnectionStatus['openai']?.connected || false;
        const isChecking = providerConnectionStatus['openai']?.checking || false;
        
        console.log('🔍 OpenAI status check:', { 
          openAIKey, 
          keyValue: keyValue ? `${keyValue.substring(0, 10)}...` : keyValue, 
          hasValue: !!keyValue, 
          hasOpenAIKey,
          openAIConnected,
          isChecking,
          allCredentials: Object.keys(apiCredentials)
        });
        
        if (!hasOpenAIKey) return 'missing';
        if (isChecking) return 'partial';
        return openAIConnected ? 'configured' : 'missing';
        
      case 'google':
        // Check if Google API key is configured (case insensitive)
        const googleKey = Object.keys(apiCredentials).find(key => key.toUpperCase() === 'GOOGLE_API_KEY');
        const googleKeyValue = googleKey ? apiCredentials[googleKey] : undefined;
        // Don't consider encrypted placeholders as valid API keys for connection testing
        const hasGoogleKey = googleKey && googleKeyValue && googleKeyValue.trim().length > 0 && !googleKeyValue.includes('[ENCRYPTED]');
        
        // Only show configured if we have both API key AND confirmed connection
        const googleConnected = providerConnectionStatus['google']?.connected || false;
        const googleChecking = providerConnectionStatus['google']?.checking || false;
        
        if (!hasGoogleKey) return 'missing';
        if (googleChecking) return 'partial';
        return googleConnected ? 'configured' : 'missing';
        
      case 'ollama':
        // Check if both LLM and embedding instances are configured and online
        if (llmStatus.online && embeddingStatus.online) return 'configured';
        if (llmStatus.online || embeddingStatus.online) return 'partial';
        return 'missing';
      case 'anthropic':
        // Check if Anthropic API key is configured (case insensitive)
        const anthropicKey = Object.keys(apiCredentials).find(key => key.toUpperCase() === 'ANTHROPIC_API_KEY');
        const hasAnthropicKey = anthropicKey && apiCredentials[anthropicKey] && apiCredentials[anthropicKey].trim().length > 0;
        return hasAnthropicKey ? 'configured' : 'missing';
      case 'grok':
        // Check if Grok API key is configured (case insensitive)
        const grokKey = Object.keys(apiCredentials).find(key => key.toUpperCase() === 'GROK_API_KEY');
        const hasGrokKey = grokKey && apiCredentials[grokKey] && apiCredentials[grokKey].trim().length > 0;
        return hasGrokKey ? 'configured' : 'missing';
      case 'openrouter':
        // Check if OpenRouter API key is configured (case insensitive)
        const openRouterKey = Object.keys(apiCredentials).find(key => key.toUpperCase() === 'OPENROUTER_API_KEY');
        const hasOpenRouterKey = openRouterKey && apiCredentials[openRouterKey] && apiCredentials[openRouterKey].trim().length > 0;
        return hasOpenRouterKey ? 'configured' : 'missing';
      default:
        return 'missing';
    }
  };;
  
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
    if (!hasRunInitialTestRef.current && 
        ragSettings.LLM_PROVIDER === 'ollama' && 
        Object.keys(ragSettings).length > 0 && 
        (llmInstanceConfig.url || embeddingInstanceConfig.url)) {
      
      hasRunInitialTestRef.current = true;
      console.log('🔄 Settings page loaded with Ollama - Testing connectivity');
      
      // Test LLM instance if configured (use URL presence as the key indicator)
      // Only test if URL is explicitly set in ragSettings, not just using the default
      if (llmInstanceConfig.url && ragSettings.LLM_BASE_URL) {
        setTimeout(() => {
          const instanceName = llmInstanceConfig.name || 'LLM Instance';
          console.log('🔍 Testing LLM instance on page load:', instanceName, llmInstanceConfig.url);
          manualTestConnection(llmInstanceConfig.url, setLLMStatus, instanceName);
        }, 1000); // Increased delay to ensure component is fully ready
      }
      
      // Test Embedding instance if configured and different from LLM instance
      // Only test if URL is explicitly set in ragSettings, not just using the default
      if (embeddingInstanceConfig.url && ragSettings.OLLAMA_EMBEDDING_URL &&
          embeddingInstanceConfig.url !== llmInstanceConfig.url) {
        setTimeout(() => {
          const instanceName = embeddingInstanceConfig.name || 'Embedding Instance';
          console.log('🔍 Testing Embedding instance on page load:', instanceName, embeddingInstanceConfig.url);
          manualTestConnection(embeddingInstanceConfig.url, setEmbeddingStatus, instanceName);
        }, 1500); // Stagger the tests
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
        
        {/* Provider Selection - 6 Button Layout */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            LLM Provider
          </label>
          <div className="grid grid-cols-6 gap-3 mb-4">
            {[
              { key: 'openai', name: 'OpenAI', logo: '/img/OpenAI.png', color: 'green' },
              { key: 'google', name: 'Google', logo: '/img/google-logo.svg', color: 'blue' },
              { key: 'ollama', name: 'Ollama', logo: '/img/Ollama.png', color: 'purple' },
              { key: 'anthropic', name: 'Anthropic', logo: '/img/claude-logo.svg', color: 'orange' },
              { key: 'grok', name: 'Grok', logo: '/img/Grok.png', color: 'yellow' },
              { key: 'openrouter', name: 'OpenRouter', logo: '/img/OpenRouter.png', color: 'cyan' }
            ].map(provider => (
              <button
                key={provider.key}
                type="button"
                onClick={() => {
                  const updatedSettings = {
                    ...ragSettings,
                    LLM_PROVIDER: provider.key
                  };
                  
                  // Set models to provider-appropriate defaults when switching providers
                  // This ensures both LLM and embedding models switch when provider changes
                  const getDefaultChatModel = (provider: string): string => {
                    switch (provider) {
                      case 'openai': return 'gpt-4o-mini';
                      case 'anthropic': return 'claude-3-5-sonnet-20241022';
                      case 'google': return 'gemini-1.5-flash';
                      case 'grok': return 'grok-2-latest';
                      case 'ollama': return '';
                      case 'openrouter': return 'anthropic/claude-3.5-sonnet';
                      default: return 'gpt-4o-mini';
                    }
                  };
                  
                  const getDefaultEmbeddingModel = (provider: string): string => {
                    switch (provider) {
                      case 'openai': return 'text-embedding-3-small';
                      case 'google': return 'text-embedding-004';
                      case 'ollama': return '';
                      case 'openrouter': return 'text-embedding-3-small';
                      case 'anthropic': 
                      case 'grok': 
                      default: return 'text-embedding-3-small';
                    }
                  };
                  
                  updatedSettings.MODEL_CHOICE = getDefaultChatModel(provider.key);
                  updatedSettings.EMBEDDING_MODEL = getDefaultEmbeddingModel(provider.key);
                  
                  setRagSettings(updatedSettings);
                }}
                className={`
                  relative p-3 rounded-lg border-2 transition-all duration-200 text-center
                  ${ragSettings.LLM_PROVIDER === provider.key
                    ? `border-${provider.color}-500 bg-${provider.color}-500/10 shadow-[0_0_15px_rgba(34,197,94,0.3)]`
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
                <div className={`text-sm font-medium text-gray-700 dark:text-gray-300 ${
                  provider.key === 'openrouter' ? 'text-center' : ''
                }`}>
                  {provider.name}
                </div>
{(() => {
                  const status = getProviderStatus(provider.key);
                  const isSelected = ragSettings.LLM_PROVIDER === provider.key;
                  
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
                {(provider.key === 'anthropic' || provider.key === 'grok' || provider.key === 'openrouter') && (
                  <div className="absolute inset-0 bg-black/20 rounded-lg flex items-center justify-center">
                    <div className="bg-yellow-500/80 text-black text-xs font-bold px-2 py-1 rounded transform -rotate-12">
                      Coming Soon
                    </div>
                  </div>
                )}
              </button>
            ))}
          </div>
          
          {/* Provider-specific configuration */}
          {ragSettings.LLM_PROVIDER === 'ollama' && (
            <div className="bg-gray-800 rounded-lg p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-white text-lg font-semibold">Ollama Configuration</h3>
                  <p className="text-gray-400 text-sm">Configure separate Ollama instances for LLM and embedding models</p>
                </div>
                <div className={`text-sm font-medium ${
                  (llmStatus.online && embeddingStatus.online) ? "text-teal-400" : 
                  (llmStatus.online || embeddingStatus.online) ? "text-yellow-400" : "text-red-400"
                }`}>
                  {(llmStatus.online && embeddingStatus.online) ? "2 / 2 Online" :
                   (llmStatus.online || embeddingStatus.online) ? "1 / 2 Online" : "0 / 2 Online"}
                </div>
              </div>

              {/* LLM Instance Card */}
              <div className="bg-gray-700 rounded-lg p-4 mb-4">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h4 className="text-white font-medium">LLM Instance</h4>
                    <p className="text-gray-400 text-sm">For chat completions and text generation</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {llmStatus.checking ? (
                      <span className="text-yellow-400 text-sm">Checking...</span>
                    ) : llmStatus.online ? (
                      <span className="text-teal-400 text-sm">Online ({llmStatus.responseTime}ms)</span>
                    ) : (
                      <span className="text-red-400 text-sm">Offline</span>
                    )}
                    {llmInstanceConfig.name && llmInstanceConfig.url && (
                      <button 
                        className="text-red-400 hover:text-red-300 transition-colors"
                        onClick={handleDeleteLLMInstance}
                        title="Delete LLM instance configuration"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                
                <div className="flex justify-between items-start">
                  <div className="flex-1">
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
                        
                        <div className="text-gray-400 text-sm">
                          {llmStatus.checking ? (
                            <Loader className="w-4 h-4 animate-spin inline mr-1" />
                          ) : null}
                          {ollamaMetrics.loading ? 'Loading...' : `${ollamaMetrics.llmInstanceModels.total} models available`}
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <div className="text-gray-400 text-sm mb-2">No LLM instance configured</div>
                        <div className="text-gray-500 text-xs mb-4">Configure an instance to use LLM features</div>
                        
                        {/* Quick setup for single host users */}
                        {!embeddingInstanceConfig.url && (
                          <div className="flex flex-col gap-2">
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="text-green-400 border-green-400 mb-1"
                              onClick={() => {
                                // Quick setup: configure both instances with default values
                                const defaultUrl = 'http://localhost:11434/v1';
                                const defaultName = 'Default Ollama';
                                setLLMInstanceConfig({ name: defaultName, url: defaultUrl });
                                setEmbeddingInstanceConfig({ name: defaultName, url: defaultUrl });
                                setShowEditLLMModal(true);
                              }}
                            >
                              ⚡ Quick Setup (Single Host)
                            </Button>
                            <div className="text-gray-500 text-xs mb-2">Sets up both LLM and Embedding for one host</div>
                          </div>
                        )}
                        
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="text-purple-400 border-purple-400"
                          onClick={() => setShowEditLLMModal(true)}
                        >
                          Add LLM Instance
                        </Button>
                      </div>
                    )}
                  </div>

                  {llmInstanceConfig.name && llmInstanceConfig.url && (
                    <div className="flex flex-col gap-2 ml-4">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-purple-400 border-purple-400"
                        onClick={() => setShowEditLLMModal(true)}
                      >
                        Edit Settings
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-purple-400 border-purple-400"
                        onClick={() => manualTestConnection(llmInstanceConfig.url, setLLMStatus, llmInstanceConfig.name)}
                        disabled={llmStatus.checking}
                    >
                      {llmStatus.checking ? 'Testing...' : 'Test Connection'}
                    </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-purple-400 border-purple-400"
                        onClick={() => setShowLLMModelSelectionModal(true)}
                      >
                        Select Model
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Embedding Instance Card */}
              <div className="bg-gray-700 rounded-lg p-4 mb-4">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h4 className="text-white font-medium">Embedding Instance</h4>
                    <p className="text-gray-400 text-sm">For generating text embeddings and vector search</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {embeddingStatus.checking ? (
                      <span className="text-yellow-400 text-sm">Checking...</span>
                    ) : embeddingStatus.online ? (
                      <span className="text-teal-400 text-sm">Online ({embeddingStatus.responseTime}ms)</span>
                    ) : (
                      <span className="text-red-400 text-sm">Offline</span>
                    )}
                    {embeddingInstanceConfig.name && embeddingInstanceConfig.url && (
                      <button 
                        className="text-red-400 hover:text-red-300 transition-colors"
                        onClick={handleDeleteEmbeddingInstance}
                        title="Delete Embedding instance configuration"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                
                <div className="flex justify-between items-start">
                  <div className="flex-1">
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
                        
                        <div className="text-gray-400 text-sm">
                          {embeddingStatus.checking ? (
                            <Loader className="w-4 h-4 animate-spin inline mr-1" />
                          ) : null}
                          {ollamaMetrics.loading ? 'Loading...' : `${ollamaMetrics.embeddingInstanceModels.total} models available`}
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <div className="text-gray-400 text-sm mb-2">No Embedding instance configured</div>
                        <div className="text-gray-500 text-xs mb-4">Configure an instance to use embedding features</div>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="text-purple-400 border-purple-400"
                          onClick={() => setShowEditEmbeddingModal(true)}
                        >
                          Add Embedding Instance
                        </Button>
                      </div>
                    )}
                  </div>

                  {embeddingInstanceConfig.name && embeddingInstanceConfig.url && (
                    <div className="flex flex-col gap-2 ml-4">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-purple-400 border-purple-400"
                        onClick={() => setShowEditEmbeddingModal(true)}
                      >
                        Edit Settings
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-purple-400 border-purple-400"
                        onClick={() => manualTestConnection(embeddingInstanceConfig.url, setEmbeddingStatus, embeddingInstanceConfig.name)}
                        disabled={embeddingStatus.checking}
                      >
                        {embeddingStatus.checking ? 'Testing...' : 'Test Connection'}
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-purple-400 border-purple-400"
                        onClick={() => setShowEmbeddingModelSelectionModal(true)}
                      >
                        Select Model
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Single Host Indicator */}
              {llmInstanceConfig.url && embeddingInstanceConfig.url && 
               llmInstanceConfig.url === embeddingInstanceConfig.url && (
                <div className="bg-green-900/30 border border-green-500/30 rounded-lg p-3 mb-4">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
                    </svg>
                    <span className="text-green-300 font-medium">Single Host Setup</span>
                  </div>
                  <p className="text-green-200/80 text-sm mt-1 ml-7">
                    Both LLM and Embedding instances are using the same Ollama host ({llmInstanceConfig.name})
                  </p>
                </div>
              )}

              {/* Configuration Summary */}
              <div className="bg-gray-700 rounded-lg p-4">
                <h4 className="text-white font-medium mb-3">Configuration Summary</h4>
                
                {/* Instance Comparison Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-600">
                        <th className="text-left py-2 text-gray-300 font-medium">Configuration</th>
                        <th className="text-left py-2 text-gray-300 font-medium">LLM Instance</th>
                        <th className="text-left py-2 text-gray-300 font-medium">Embedding Instance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-600">
                      <tr>
                        <td className="py-2 text-gray-400">Instance Name</td>
                        <td className="py-2 text-white">
                          {llmInstanceConfig.name || <span className="text-gray-500 italic">Not configured</span>}
                        </td>
                        <td className="py-2 text-white">
                          {embeddingInstanceConfig.name || <span className="text-gray-500 italic">Not configured</span>}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 text-gray-400">Status</td>
                        <td className="py-2">
                          <span className={llmStatus.checking ? "text-yellow-400" : llmStatus.online ? "text-teal-400" : "text-red-400"}>
                            {llmStatus.checking ? "Checking..." : llmStatus.online ? `Online (${llmStatus.responseTime}ms)` : "Offline"}
                          </span>
                        </td>
                        <td className="py-2">
                          <span className={embeddingStatus.checking ? "text-yellow-400" : embeddingStatus.online ? "text-teal-400" : "text-red-400"}>
                            {embeddingStatus.checking ? "Checking..." : embeddingStatus.online ? `Online (${embeddingStatus.responseTime}ms)` : "Offline"}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 text-gray-400">Selected Model</td>
                        <td className="py-2 text-white">
                          {getDisplayedChatModel(ragSettings) || <span className="text-gray-500 italic">No model selected</span>}
                        </td>
                        <td className="py-2 text-white">
                          {getDisplayedEmbeddingModel(ragSettings) || <span className="text-gray-500 italic">No model selected</span>}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 text-gray-400">Available Models</td>
                        <td className="py-2">
                          {ollamaMetrics.loading ? (
                            <Loader className="w-3 h-3 animate-spin inline" />
                          ) : (
                            <div className="text-white">
                              <div className="font-medium">{ollamaMetrics.llmInstanceModels.total} Total Models</div>
                              {ollamaMetrics.llmInstanceModels.total > 0 && (
                                <div className="text-xs text-gray-400 mt-1">
                                  <span className="inline-block mr-3">
                                    <span className="text-blue-400">{ollamaMetrics.llmInstanceModels.chat}</span> Chat
                                  </span>
                                  <span className="inline-block">
                                    <span className="text-green-400">{ollamaMetrics.llmInstanceModels.embedding}</span> Embedding
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2">
                          {ollamaMetrics.loading ? (
                            <Loader className="w-3 h-3 animate-spin inline" />
                          ) : (
                            <div className="text-white">
                              <div className="font-medium">{ollamaMetrics.embeddingInstanceModels.total} Total Models</div>
                              {ollamaMetrics.embeddingInstanceModels.total > 0 && (
                                <div className="text-xs text-gray-400 mt-1">
                                  <span className="inline-block mr-3">
                                    <span className="text-blue-400">{ollamaMetrics.embeddingInstanceModels.chat}</span> Chat
                                  </span>
                                  <span className="inline-block">
                                    <span className="text-green-400">{ollamaMetrics.embeddingInstanceModels.embedding}</span> Embedding
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  
                  {/* System Readiness Summary */}
                  <div className="mt-4 pt-3 border-t border-gray-600">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">System Readiness:</span>
                      <span className={(llmStatus.online && embeddingStatus.online) ? "text-teal-400 font-medium" : (llmStatus.online || embeddingStatus.online) ? "text-yellow-400" : "text-red-400"}>
                        {(llmStatus.online && embeddingStatus.online) ? "✓ Ready (Both Instances Online)" : 
                         (llmStatus.online || embeddingStatus.online) ? "⚠ Partial (1 of 2 Online)" : "✗ Not Ready (No Instances Online)"}
                      </span>
                    </div>
                    
                    {/* Overall Model Metrics */}
                    <div className="mt-3 flex items-center gap-4 text-xs text-gray-400">
                      <div className="flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
                        </svg>
                        <span>Overall Available:</span>
                        <span className="text-white">
                          {ollamaMetrics.loading ? (
                            <Loader className="w-3 h-3 animate-spin inline" />
                          ) : (
                            `${ollamaMetrics.totalModels} total (${ollamaMetrics.chatModels} chat, ${ollamaMetrics.embeddingModels} embedding)`
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {ragSettings.LLM_PROVIDER === 'anthropic' && (
            <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg mb-4">
              <p className="text-sm text-orange-800 dark:text-orange-300">
                Configure your Anthropic API key in the credentials section to use Claude models.
              </p>
            </div>
          )}

          {ragSettings.LLM_PROVIDER === 'groq' && (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg mb-4">
              <p className="text-sm text-yellow-800 dark:text-yellow-300">
                Groq provides fast inference with Llama, Mixtral, and Gemma models.
              </p>
            </div>
          )}
          
          <div className="flex justify-end">
            <Button 
              variant="outline" 
              accentColor="green" 
              icon={saving ? <Loader className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
              className="whitespace-nowrap"
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
        </div>

        {/* Model Settings Row - Only show for non-Ollama providers */}
        {ragSettings.LLM_PROVIDER !== 'ollama' && (
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <Input 
                label="Chat Model" 
                value={getDisplayedChatModel(ragSettings)} 
                onChange={e => setRagSettings({
                  ...ragSettings,
                  MODEL_CHOICE: e.target.value
                })} 
                placeholder={getModelPlaceholder(ragSettings.LLM_PROVIDER || 'openai')}
                accentColor="green" 
              />
            </div>
            <div>
              <Input
                label="Embedding Model"
                value={getDisplayedEmbeddingModel(ragSettings)}
                onChange={e => setRagSettings({
                  ...ragSettings,
                  EMBEDDING_MODEL: e.target.value
                })}
                placeholder={getEmbeddingPlaceholder(ragSettings.LLM_PROVIDER || 'openai')}
                accentColor="green"
              />
            </div>
          </div>
        )}
        
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
                  placeholder="http://localhost:11434/v1"
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
                      manualTestConnection(llmInstanceConfig.url, setLLMStatus, llmInstanceConfig.name);
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
                  placeholder="http://localhost:11434/v1"
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
                      manualTestConnection(embeddingInstanceConfig.url, setEmbeddingStatus, embeddingInstanceConfig.name);
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
            selectedInstanceUrl={llmInstanceConfig.url.replace('/v1', '')}
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
            selectedInstanceUrl={embeddingInstanceConfig.url.replace('/v1', '')}
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
function getDisplayedChatModel(ragSettings: any): string {
  const provider = ragSettings.LLM_PROVIDER || 'openai';
  const modelChoice = ragSettings.MODEL_CHOICE;
  
  // Check if the stored model is appropriate for the current provider
  const isModelAppropriate = (model: string, provider: string): boolean => {
    if (!model) return false;
    
    switch (provider) {
      case 'openai':
        return model.startsWith('gpt-') || model.startsWith('o1-') || model.includes('text-davinci') || model.includes('text-embedding');
      case 'anthropic':
        return model.startsWith('claude-');
      case 'google':
        return model.startsWith('gemini-') || model.startsWith('text-embedding-');
      case 'grok':
        return model.startsWith('grok-');
      case 'ollama':
        return !model.startsWith('gpt-') && !model.startsWith('claude-') && !model.startsWith('gemini-') && !model.startsWith('grok-');
      case 'openrouter':
        return model.includes('/') || model.startsWith('anthropic/') || model.startsWith('openai/');
      default:
        return false;
    }
  };
  
  // Use stored model if it's appropriate for the provider, otherwise use default
  const useStoredModel = modelChoice && isModelAppropriate(modelChoice, provider);
  
  switch (provider) {
    case 'openai':
      return useStoredModel ? modelChoice : 'gpt-4o-mini';
    case 'anthropic':
      return useStoredModel ? modelChoice : 'claude-3-5-sonnet-20241022';
    case 'google':
      return useStoredModel ? modelChoice : 'gemini-1.5-flash';
    case 'grok':
      return useStoredModel ? modelChoice : 'grok-2-latest';
    case 'ollama':
      return useStoredModel ? modelChoice : '';
    case 'openrouter':
      return useStoredModel ? modelChoice : 'anthropic/claude-3.5-sonnet';
    default:
      return useStoredModel ? modelChoice : 'gpt-4o-mini';
  }
}

function getDisplayedEmbeddingModel(ragSettings: any): string {
  const provider = ragSettings.LLM_PROVIDER || 'openai';
  const embeddingModel = ragSettings.EMBEDDING_MODEL;
  
  // Check if the stored embedding model is appropriate for the current provider
  const isEmbeddingModelAppropriate = (model: string, provider: string): boolean => {
    if (!model) return false;
    
    switch (provider) {
      case 'openai':
        return model.startsWith('text-embedding-') || model.includes('ada-');
      case 'anthropic':
        return false; // Claude doesn't provide embedding models
      case 'google':
        return model.startsWith('text-embedding-') || model.startsWith('textembedding-') || model.includes('embedding');
      case 'grok':
        return false; // Grok doesn't provide embedding models
      case 'ollama':
        return !model.startsWith('text-embedding-') || model.includes('embed') || model.includes('arctic');
      case 'openrouter':
        return model.startsWith('text-embedding-') || model.includes('/');
      default:
        return false;
    }
  };
  
  // Use stored model if it's appropriate for the provider, otherwise use default
  const useStoredModel = embeddingModel && isEmbeddingModelAppropriate(embeddingModel, provider);
  
  switch (provider) {
    case 'openai':
      return useStoredModel ? embeddingModel : 'text-embedding-3-small';
    case 'anthropic':
      return 'Not available - Claude does not provide embedding models';
    case 'google':
      return useStoredModel ? embeddingModel : 'text-embedding-004';
    case 'grok':
      return 'Not available - Grok does not provide embedding models';
    case 'ollama':
      return useStoredModel ? embeddingModel : '';
    case 'openrouter':
      return useStoredModel ? embeddingModel : 'text-embedding-3-small';
    default:
      return useStoredModel ? embeddingModel : 'text-embedding-3-small';
  }
}

// Helper functions for model placeholders
function getModelPlaceholder(provider: string): string {
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

function getEmbeddingPlaceholder(provider: string): string {
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