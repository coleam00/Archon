import React, { useState, useEffect, useMemo, useCallback } from 'react';

// FORCE DEBUG - This should ALWAYS appear in console when this file loads
console.log('🚨 DEBUG: OllamaModelDiscoveryModal.tsx file loaded at', new Date().toISOString());
import { 
  X, Search, Activity, Database, Zap, Clock, Server, 
  Loader, CheckCircle, AlertCircle, Filter, Download,
  MessageCircle, Layers, Cpu, HardDrive
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { useToast } from '../../contexts/ToastContext';
import { ollamaService, type OllamaModel, type ModelDiscoveryResponse } from '../../services/ollamaService';
import type { OllamaInstance, ModelSelectionState } from './types/OllamaTypes';

interface OllamaModelDiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectModels: (selection: { chatModel?: string; embeddingModel?: string }) => void;
  instances: OllamaInstance[];
  initialChatModel?: string;
  initialEmbeddingModel?: string;
}

interface EnrichedModel extends OllamaModel {
  instanceName?: string;
  status: 'available' | 'testing' | 'error';
  testResult?: {
    chatWorks: boolean;
    embeddingWorks: boolean;
    dimensions?: number;
  };
}

const OllamaModelDiscoveryModal: React.FC<OllamaModelDiscoveryModalProps> = ({
  isOpen,
  onClose,
  onSelectModels,
  instances,
  initialChatModel,
  initialEmbeddingModel
}) => {
  console.log('🔴 COMPONENT DEBUG: OllamaModelDiscoveryModal component loaded/rendered', { isOpen });
  const [models, setModels] = useState<EnrichedModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<string>('');
  const [lastDiscoveryTime, setLastDiscoveryTime] = useState<number | null>(null);
  const [hasCache, setHasCache] = useState(false);
  
  const [selectionState, setSelectionState] = useState<ModelSelectionState>({
    selectedChatModel: initialChatModel || null,
    selectedEmbeddingModel: initialEmbeddingModel || null,
    filterText: '',
    showOnlyEmbedding: false,
    showOnlyChat: false,
    sortBy: 'name'
  });

  const [testingModels, setTestingModels] = useState<Set<string>>(new Set());
  
  const { showToast } = useToast();

  // Get enabled instance URLs
  const enabledInstanceUrls = useMemo(() => {
    return instances
      .filter(instance => instance.isEnabled)
      .map(instance => instance.baseUrl);
  }, [instances]);

  // Create instance lookup map
  const instanceLookup = useMemo(() => {
    const lookup: Record<string, OllamaInstance> = {};
    instances.forEach(instance => {
      lookup[instance.baseUrl] = instance;
    });
    return lookup;
  }, [instances]);

  // Generate cache key based on enabled instances
  const cacheKey = useMemo(() => {
    const sortedUrls = [...enabledInstanceUrls].sort();
    const key = `ollama-models-${sortedUrls.join('|')}`;
    console.log('🟡 CACHE KEY DEBUG: Generated cache key', {
      key,
      enabledInstanceUrls,
      sortedUrls
    });
    return key;
  }, [enabledInstanceUrls]);

  // Save models to localStorage
  const saveModelsToCache = useCallback((modelsToCache: EnrichedModel[]) => {
    try {
      console.log('🟡 CACHE DEBUG: Attempting to save models to cache', {
        cacheKey,
        modelCount: modelsToCache.length,
        instanceUrls: enabledInstanceUrls,
        timestamp: Date.now()
      });
      
      const cacheData = {
        models: modelsToCache,
        timestamp: Date.now(),
        instanceUrls: enabledInstanceUrls
      };
      
      localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      setLastDiscoveryTime(Date.now());
      setHasCache(true);
      
      console.log('🟢 CACHE DEBUG: Successfully saved models to cache', {
        cacheKey,
        modelCount: modelsToCache.length,
        cacheSize: JSON.stringify(cacheData).length,
        storedInLocalStorage: !!localStorage.getItem(cacheKey)
      });
    } catch (error) {
      console.error('🔴 CACHE DEBUG: Failed to save models to cache:', error);
    }
  }, [cacheKey, enabledInstanceUrls]);

  // Load models from localStorage
  const loadModelsFromCache = useCallback(() => {
    console.log('🟡 CACHE DEBUG: Attempting to load models from cache', {
      cacheKey,
      enabledInstanceUrls,
      hasLocalStorageItem: !!localStorage.getItem(cacheKey)
    });
    
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        console.log('🟡 CACHE DEBUG: Found cached data', {
          cacheKey,
          cacheSize: cached.length
        });
        
        const cacheData = JSON.parse(cached);
        const cacheAge = Date.now() - cacheData.timestamp;
        const cacheAgeMinutes = Math.floor(cacheAge / (60 * 1000));
        
        console.log('🟡 CACHE DEBUG: Cache data parsed', {
          modelCount: cacheData.models?.length,
          timestamp: cacheData.timestamp,
          cacheAge,
          cacheAgeMinutes,
          cachedInstanceUrls: cacheData.instanceUrls,
          currentInstanceUrls: enabledInstanceUrls
        });
        
        // Use cache if less than 10 minutes old and same instances
        const instanceUrlsMatch = JSON.stringify(cacheData.instanceUrls?.sort()) === JSON.stringify([...enabledInstanceUrls].sort());
        const isCacheValid = cacheAge < 10 * 60 * 1000 && instanceUrlsMatch;
        
        console.log('🟡 CACHE DEBUG: Cache validation', {
          isCacheValid,
          cacheAge: cacheAge,
          maxAge: 10 * 60 * 1000,
          instanceUrlsMatch,
          cachedUrls: JSON.stringify(cacheData.instanceUrls?.sort()),
          currentUrls: JSON.stringify([...enabledInstanceUrls].sort())
        });
        
        if (isCacheValid) {
          console.log('🟢 CACHE DEBUG: Using cached models', {
            modelCount: cacheData.models.length,
            timestamp: cacheData.timestamp
          });
          
          setModels(cacheData.models);
          setDiscoveryComplete(true);
          setLastDiscoveryTime(cacheData.timestamp);
          setHasCache(true);
          setDiscoveryProgress(`Loaded ${cacheData.models.length} cached models`);
          return true;
        } else {
          console.log('🟠 CACHE DEBUG: Cache invalid - will refresh', {
            reason: cacheAge >= 10 * 60 * 1000 ? 'expired' : 'different instances'
          });
        }
      } else {
        console.log('🟠 CACHE DEBUG: No cached data found for key:', cacheKey);
      }
    } catch (error) {
      console.error('🔴 CACHE DEBUG: Failed to load cached models:', error);
    }
    return false;
  }, [cacheKey, enabledInstanceUrls]);

  // Test localStorage functionality (run once when component mounts)
  useEffect(() => {
    const testLocalStorage = () => {
      try {
        const testKey = 'ollama-test-key';
        const testData = { test: 'localStorage working', timestamp: Date.now() };
        
        console.log('🔧 LOCALSTORAGE DEBUG: Testing localStorage functionality');
        localStorage.setItem(testKey, JSON.stringify(testData));
        
        const retrieved = localStorage.getItem(testKey);
        const parsed = retrieved ? JSON.parse(retrieved) : null;
        
        console.log('🟢 LOCALSTORAGE DEBUG: localStorage test successful', {
          saved: testData,
          retrieved: parsed,
          working: !!parsed && parsed.test === testData.test
        });
        
        localStorage.removeItem(testKey);
        
      } catch (error) {
        console.error('🔴 LOCALSTORAGE DEBUG: localStorage test failed', error);
      }
    };
    
    testLocalStorage();
  }, []); // Run once on mount

  // Check cache when modal opens or instances change
  useEffect(() => {
    if (isOpen && enabledInstanceUrls.length > 0) {
      console.log('🟡 MODAL DEBUG: Modal opened, checking cache', {
        isOpen,
        enabledInstanceUrls,
        instanceUrlsCount: enabledInstanceUrls.length
      });
      loadModelsFromCache(); // Progress message is set inside this function
    } else {
      console.log('🟡 MODAL DEBUG: Modal state change', {
        isOpen,
        enabledInstanceUrlsCount: enabledInstanceUrls.length
      });
    }
  }, [isOpen, enabledInstanceUrls, loadModelsFromCache]);

  // Discover models when modal opens
  const discoverModels = useCallback(async (forceRefresh: boolean = false) => {
    console.log('🚨 DISCOVERY DEBUG: discoverModels FUNCTION CALLED', {
      forceRefresh,
      enabledInstanceUrls,
      instanceUrlsCount: enabledInstanceUrls.length,
      timestamp: new Date().toISOString(),
      callStack: new Error().stack?.split('\n').slice(0, 3)
    });
    console.log('🟡 DISCOVERY DEBUG: Starting model discovery', {
      forceRefresh,
      enabledInstanceUrls,
      instanceUrlsCount: enabledInstanceUrls.length,
      timestamp: new Date().toISOString()
    });
    
    if (enabledInstanceUrls.length === 0) {
      console.log('🔴 DISCOVERY DEBUG: No enabled instances');
      setError('No enabled Ollama instances configured');
      return;
    }

    // Check cache first if not forcing refresh
    if (!forceRefresh) {
      console.log('🟡 DISCOVERY DEBUG: Checking cache before discovery');
      const loaded = loadModelsFromCache();
      if (loaded) {
        console.log('🟢 DISCOVERY DEBUG: Used cached models, skipping API call');
        return; // Progress message already set by loadModelsFromCache
      }
      console.log('🟡 DISCOVERY DEBUG: No valid cache, proceeding with API discovery');
    } else {
      console.log('🟡 DISCOVERY DEBUG: Force refresh requested, skipping cache');
    }

    const discoveryStartTime = Date.now();
    console.log('🟡 DISCOVERY DEBUG: Starting API discovery at', new Date(discoveryStartTime).toISOString());

    setLoading(true);
    setError(null);
    setDiscoveryComplete(false);
    setDiscoveryProgress(`Discovering models from ${enabledInstanceUrls.length} instance(s)...`);

    try {
      // Discover models (no timeout - let it complete naturally)
      console.log('🚨 DISCOVERY DEBUG: About to call ollamaService.discoverModels', {
        instanceUrls: enabledInstanceUrls,
        includeCapabilities: true,
        timestamp: new Date().toISOString()
      });
      
      const discoveryResult = await ollamaService.discoverModels({
        instanceUrls: enabledInstanceUrls,
        includeCapabilities: true
      });
      
      console.log('🚨 DISCOVERY DEBUG: ollamaService.discoverModels returned', {
        totalModels: discoveryResult.total_models,
        chatModelsCount: discoveryResult.chat_models?.length,
        embeddingModelsCount: discoveryResult.embedding_models?.length,
        hostStatusCount: Object.keys(discoveryResult.host_status || {}).length,
        timestamp: new Date().toISOString()
      });
      
      const discoveryEndTime = Date.now();
      const discoveryDuration = discoveryEndTime - discoveryStartTime;
      console.log('🟢 DISCOVERY DEBUG: API discovery completed', {
        duration: discoveryDuration,
        durationSeconds: (discoveryDuration / 1000).toFixed(1),
        totalModels: discoveryResult.total_models,
        chatModels: discoveryResult.chat_models.length,
        embeddingModels: discoveryResult.embedding_models.length,
        hostStatus: Object.keys(discoveryResult.host_status).length,
        errors: discoveryResult.discovery_errors.length
      });

      // Enrich models with instance information and status
      const enrichedModels: EnrichedModel[] = [];
      
      // Process chat models
      discoveryResult.chat_models.forEach(chatModel => {
        const instance = instanceLookup[chatModel.instance_url];
        const enriched: EnrichedModel = {
          name: chatModel.name,
          tag: chatModel.name,
          size: chatModel.size,
          digest: '',
          capabilities: ['chat'],
          instance_url: chatModel.instance_url,
          instanceName: instance?.name || 'Unknown',
          status: 'available',
          parameters: chatModel.parameters
        };
        enrichedModels.push(enriched);
      });

      // Process embedding models
      discoveryResult.embedding_models.forEach(embeddingModel => {
        const instance = instanceLookup[embeddingModel.instance_url];
        
        // Check if we already have this model (might support both chat and embedding)
        const existingModel = enrichedModels.find(m => 
          m.name === embeddingModel.name && m.instance_url === embeddingModel.instance_url
        );
        
        if (existingModel) {
          // Add embedding capability
          existingModel.capabilities.push('embedding');
          existingModel.embedding_dimensions = embeddingModel.dimensions;
        } else {
          // Create new model entry
          const enriched: EnrichedModel = {
            name: embeddingModel.name,
            tag: embeddingModel.name,
            size: embeddingModel.size,
            digest: '',
            capabilities: ['embedding'],
            embedding_dimensions: embeddingModel.dimensions,
            instance_url: embeddingModel.instance_url,
            instanceName: instance?.name || 'Unknown',
            status: 'available'
          };
          enrichedModels.push(enriched);
        }
      });

      console.log('🚨 DISCOVERY DEBUG: About to call setModels', {
        enrichedModelsCount: enrichedModels.length,
        enrichedModels: enrichedModels.map(m => ({ name: m.name, capabilities: m.capabilities })),
        timestamp: new Date().toISOString()
      });
      
      setModels(enrichedModels);
      setDiscoveryComplete(true);
      
      console.log('🚨 DISCOVERY DEBUG: Called setModels and setDiscoveryComplete', {
        enrichedModelsCount: enrichedModels.length,
        timestamp: new Date().toISOString()
      });
      
      // Cache the discovered models
      saveModelsToCache(enrichedModels);
      
      showToast(
        `Discovery complete: Found ${discoveryResult.total_models} models across ${Object.keys(discoveryResult.host_status).length} instances`,
        'success'
      );

      if (discoveryResult.discovery_errors.length > 0) {
        showToast(`Some hosts had errors: ${discoveryResult.discovery_errors.length} issues`, 'warning');
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error occurred';
      setError(errorMsg);
      showToast(`Model discovery failed: ${errorMsg}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [enabledInstanceUrls, instanceLookup, showToast, loadModelsFromCache, saveModelsToCache]);

  // Test model capabilities
  const testModelCapabilities = useCallback(async (model: EnrichedModel) => {
    const modelKey = `${model.name}@${model.instance_url}`;
    setTestingModels(prev => new Set(prev).add(modelKey));

    try {
      const capabilities = await ollamaService.getModelCapabilities(model.name, model.instance_url);
      
      const testResult = {
        chatWorks: capabilities.supports_chat,
        embeddingWorks: capabilities.supports_embedding,
        dimensions: capabilities.embedding_dimensions
      };

      setModels(prevModels => 
        prevModels.map(m => 
          m.name === model.name && m.instance_url === model.instance_url
            ? { ...m, testResult, status: 'available' as const }
            : m
        )
      );

      if (capabilities.error) {
        showToast(`Model test completed with warnings: ${capabilities.error}`, 'warning');
      } else {
        showToast(`Model ${model.name} tested successfully`, 'success');
      }

    } catch (error) {
      setModels(prevModels => 
        prevModels.map(m => 
          m.name === model.name && m.instance_url === model.instance_url
            ? { ...m, status: 'error' as const }
            : m
        )
      );
      showToast(`Failed to test ${model.name}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setTestingModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelKey);
        return newSet;
      });
    }
  }, [showToast]);

  // Filter and sort models
  const filteredAndSortedModels = useMemo(() => {
    console.log('🚨 FILTERING DEBUG: filteredAndSortedModels useMemo running', {
      modelsLength: models.length,
      models: models.map(m => ({ name: m.name, capabilities: m.capabilities })),
      selectionState,
      timestamp: new Date().toISOString()
    });
    
    let filtered = models.filter(model => {
      // Text filter
      if (selectionState.filterText && !model.name.toLowerCase().includes(selectionState.filterText.toLowerCase())) {
        return false;
      }

      // Capability filters
      if (selectionState.showOnlyChat && !model.capabilities.includes('chat')) {
        return false;
      }
      if (selectionState.showOnlyEmbedding && !model.capabilities.includes('embedding')) {
        return false;
      }

      return true;
    });

    // Sort models
    filtered.sort((a, b) => {
      switch (selectionState.sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'size':
          return b.size - a.size;
        case 'instance':
          return (a.instanceName || '').localeCompare(b.instanceName || '');
        default:
          return 0;
      }
    });

    console.log('🚨 FILTERING DEBUG: filteredAndSortedModels result', {
      originalCount: models.length,
      filteredCount: filtered.length,
      filtered: filtered.map(m => ({ name: m.name, capabilities: m.capabilities })),
      timestamp: new Date().toISOString()
    });

    return filtered;
  }, [models, selectionState]);

  // Handle model selection
  const handleModelSelect = (model: EnrichedModel, type: 'chat' | 'embedding') => {
    if (type === 'chat' && !model.capabilities.includes('chat')) {
      showToast(`Model ${model.name} does not support chat functionality`, 'error');
      return;
    }
    
    if (type === 'embedding' && !model.capabilities.includes('embedding')) {
      showToast(`Model ${model.name} does not support embedding functionality`, 'error');
      return;
    }

    setSelectionState(prev => ({
      ...prev,
      [type === 'chat' ? 'selectedChatModel' : 'selectedEmbeddingModel']: model.name
    }));
  };

  // Apply selections and close modal
  const handleApplySelection = () => {
    onSelectModels({
      chatModel: selectionState.selectedChatModel || undefined,
      embeddingModel: selectionState.selectedEmbeddingModel || undefined
    });
    onClose();
  };

  // Reset modal state when closed
  const handleClose = () => {
    setSelectionState({
      selectedChatModel: initialChatModel || null,
      selectedEmbeddingModel: initialEmbeddingModel || null,
      filterText: '',
      showOnlyEmbedding: false,
      showOnlyChat: false,
      sortBy: 'name'
    });
    setError(null);
    onClose();
  };

  // Auto-discover when modal opens (only if no cache available)
  useEffect(() => {
    console.log('🟡 AUTO-DISCOVERY DEBUG: useEffect triggered', {
      isOpen,
      discoveryComplete,
      loading,
      hasCache,
      willAutoDiscover: isOpen && !discoveryComplete && !loading && !hasCache
    });
    
    if (isOpen && !discoveryComplete && !loading && !hasCache) {
      console.log('🟢 AUTO-DISCOVERY DEBUG: Starting auto-discovery');
      discoverModels();
    } else {
      console.log('🟠 AUTO-DISCOVERY DEBUG: Skipping auto-discovery', {
        reason: !isOpen ? 'modal closed' : 
                discoveryComplete ? 'already complete' :
                loading ? 'already loading' :
                hasCache ? 'has cache' : 'unknown'
      });
    }
  }, [isOpen, discoveryComplete, loading, hasCache, discoverModels]);

  if (!isOpen) return null;

  const modalContent = (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className="w-full max-w-4xl max-h-[85vh] mx-4 bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="border-b border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <Database className="w-6 h-6 text-green-500" />
                  Ollama Model Discovery
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  Discover and select models from your Ollama instances
                  {hasCache && lastDiscoveryTime && (
                    <span className="ml-2 text-green-600 dark:text-green-400">
                      (Cached {new Date(lastDiscoveryTime).toLocaleTimeString()})
                    </span>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClose}
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>
          </div>

          {/* Controls */}
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <div className="flex flex-col md:flex-row gap-4">
              {/* Search */}
              <div className="flex-1">
                <Input
                  type="text"
                  placeholder="Search models..."
                  value={selectionState.filterText}
                  onChange={(e) => setSelectionState(prev => ({ ...prev, filterText: e.target.value }))}
                  className="w-full"
                  icon={<Search className="w-4 h-4" />}
                />
              </div>

              {/* Filters */}
              <div className="flex gap-2">
                <Button
                  variant={selectionState.showOnlyChat ? "solid" : "outline"}
                  size="sm"
                  onClick={() => setSelectionState(prev => ({ 
                    ...prev, 
                    showOnlyChat: !prev.showOnlyChat,
                    showOnlyEmbedding: false
                  }))}
                  className="flex items-center gap-1"
                >
                  <MessageCircle className="w-4 h-4" />
                  Chat Only
                </Button>
                <Button
                  variant={selectionState.showOnlyEmbedding ? "solid" : "outline"}
                  size="sm"
                  onClick={() => setSelectionState(prev => ({ 
                    ...prev, 
                    showOnlyEmbedding: !prev.showOnlyEmbedding,
                    showOnlyChat: false
                  }))}
                  className="flex items-center gap-1"
                >
                  <Layers className="w-4 h-4" />
                  Embedding Only
                </Button>
              </div>

              {/* Refresh */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  console.log('🚨 REFRESH BUTTON CLICKED - About to call discoverModels(true)', {
                    timestamp: new Date().toISOString(),
                    loading,
                    enabledInstanceUrls,
                    instanceUrlsCount: enabledInstanceUrls.length
                  });
                  discoverModels(true);  // Force refresh
                }}
                disabled={loading}
                className="flex items-center gap-1"
              >
                {loading ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Activity className="w-4 h-4" />
                )}
                {loading ? 'Discovering...' : 'Refresh'}
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {error ? (
              <div className="p-6 text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Discovery Failed</h3>
                <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
                <Button onClick={() => discoverModels(true)}>Try Again</Button>
              </div>
            ) : loading ? (
              <div className="p-6 text-center">
                <Loader className="w-12 h-12 text-green-500 mx-auto mb-4 animate-spin" />
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Discovering Models</h3>
                <p className="text-gray-600 dark:text-gray-400 mb-2">
                  {discoveryProgress || `Scanning ${enabledInstanceUrls.length} Ollama instances...`}
                </p>
                <div className="mt-4">
                  <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                    <div className="bg-green-500 h-full animate-pulse" style={{width: '100%'}}></div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-96 overflow-y-auto p-6">
                {(() => {
                  console.log('🚨 RENDERING DEBUG: About to render models list', {
                    filteredAndSortedModelsLength: filteredAndSortedModels.length,
                    modelsLength: models.length,
                    loading,
                    error,
                    discoveryComplete,
                    timestamp: new Date().toISOString()
                  });
                  return null;
                })()}
                {filteredAndSortedModels.length === 0 ? (
                  <div className="text-center text-gray-500 dark:text-gray-400">
                    <Database className="w-16 h-16 mx-auto mb-4 opacity-50" />
                    <p className="text-lg font-medium mb-2">No models found</p>
                    <p className="text-sm">
                      {models.length === 0 
                        ? "Try refreshing to discover models from your Ollama instances"
                        : "Adjust your filters to see more models"
                      }
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-4">
                    {filteredAndSortedModels.map((model) => {
                      const modelKey = `${model.name}@${model.instance_url}`;
                      const isTesting = testingModels.has(modelKey);
                      const isChatSelected = selectionState.selectedChatModel === model.name;
                      const isEmbeddingSelected = selectionState.selectedEmbeddingModel === model.name;

                      return (
                        <Card
                          key={modelKey}
                          className={`p-4 hover:shadow-md transition-shadow ${
                            isChatSelected || isEmbeddingSelected 
                              ? 'border-green-500 bg-green-50 dark:bg-green-900/20' 
                              : ''
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-3 mb-2">
                                <h4 className="font-semibold text-gray-900 dark:text-white">{model.name}</h4>
                                
                                {/* Capability badges */}
                                <div className="flex gap-1">
                                  {model.capabilities.includes('chat') && (
                                    <Badge variant="solid" className="bg-blue-100 text-blue-800 text-xs">
                                      <MessageCircle className="w-3 h-3 mr-1" />
                                      Chat
                                    </Badge>
                                  )}
                                  {model.capabilities.includes('embedding') && (
                                    <Badge variant="solid" className="bg-purple-100 text-purple-800 text-xs">
                                      <Layers className="w-3 h-3 mr-1" />
                                      {model.embedding_dimensions}D
                                    </Badge>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400 mb-3">
                                <span className="flex items-center gap-1">
                                  <Server className="w-4 h-4" />
                                  {model.instanceName}
                                </span>
                                <span className="flex items-center gap-1">
                                  <HardDrive className="w-4 h-4" />
                                  {(model.size / (1024 ** 3)).toFixed(1)} GB
                                </span>
                                {model.parameters?.family && (
                                  <span className="flex items-center gap-1">
                                    <Cpu className="w-4 h-4" />
                                    {model.parameters.family}
                                  </span>
                                )}
                              </div>

                              {/* Test result display */}
                              {model.testResult && (
                                <div className="flex gap-2 mb-2">
                                  {model.testResult.chatWorks && (
                                    <Badge variant="solid" className="bg-green-100 text-green-800 text-xs">
                                      ✓ Chat Verified
                                    </Badge>
                                  )}
                                  {model.testResult.embeddingWorks && (
                                    <Badge variant="solid" className="bg-green-100 text-green-800 text-xs">
                                      ✓ Embedding Verified ({model.testResult.dimensions}D)
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>

                            <div className="flex flex-col gap-2">
                              {/* Action buttons */}
                              <div className="flex gap-2">
                                {model.capabilities.includes('chat') && (
                                  <Button
                                    size="sm"
                                    variant={isChatSelected ? "solid" : "outline"}
                                    onClick={() => handleModelSelect(model, 'chat')}
                                    className="text-xs"
                                  >
                                    {isChatSelected ? '✓ Selected for Chat' : 'Select for Chat'}
                                  </Button>
                                )}
                                {model.capabilities.includes('embedding') && (
                                  <Button
                                    size="sm"
                                    variant={isEmbeddingSelected ? "solid" : "outline"}
                                    onClick={() => handleModelSelect(model, 'embedding')}
                                    className="text-xs"
                                  >
                                    {isEmbeddingSelected ? '✓ Selected for Embedding' : 'Select for Embedding'}
                                  </Button>
                                )}
                              </div>

                              {/* Test button */}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => testModelCapabilities(model)}
                                disabled={isTesting}
                                className="text-xs"
                              >
                                {isTesting ? (
                                  <>
                                    <Loader className="w-3 h-3 mr-1 animate-spin" />
                                    Testing...
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle className="w-3 h-3 mr-1" />
                                    Test Model
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-600 dark:text-gray-400">
                {selectionState.selectedChatModel && (
                  <span className="mr-4">Chat: <strong>{selectionState.selectedChatModel}</strong></span>
                )}
                {selectionState.selectedEmbeddingModel && (
                  <span>Embedding: <strong>{selectionState.selectedEmbeddingModel}</strong></span>
                )}
                {!selectionState.selectedChatModel && !selectionState.selectedEmbeddingModel && (
                  <span>No models selected</span>
                )}
              </div>
              
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleApplySelection}
                  disabled={!selectionState.selectedChatModel && !selectionState.selectedEmbeddingModel}
                >
                  Apply Selection
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(modalContent, document.body);
};

export default OllamaModelDiscoveryModal;