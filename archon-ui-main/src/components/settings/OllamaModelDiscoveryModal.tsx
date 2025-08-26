import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
  const [models, setModels] = useState<EnrichedModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<string>('');
  
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

  // Discover models when modal opens
  const discoverModels = useCallback(async () => {
    if (enabledInstanceUrls.length === 0) {
      setError('No enabled Ollama instances configured');
      return;
    }

    setLoading(true);
    setError(null);
    setDiscoveryComplete(false);
    setDiscoveryProgress(`Discovering models from ${enabledInstanceUrls.length} instance(s)...`);

    try {
      // Add timeout for discovery
      const discoveryPromise = ollamaService.discoverModels({
        instanceUrls: enabledInstanceUrls,
        includeCapabilities: true
      });

      // Set a 30 second timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Model discovery timed out after 30 seconds')), 30000)
      );

      const discoveryResult = await Promise.race([
        discoveryPromise,
        timeoutPromise
      ]) as ModelDiscoveryResponse;

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
          existingModel.embeddingDimensions = embeddingModel.dimensions;
        } else {
          // Create new model entry
          const enriched: EnrichedModel = {
            name: embeddingModel.name,
            tag: embeddingModel.name,
            size: embeddingModel.size,
            digest: '',
            capabilities: ['embedding'],
            embeddingDimensions: embeddingModel.dimensions,
            instance_url: embeddingModel.instance_url,
            instanceName: instance?.name || 'Unknown',
            status: 'available'
          };
          enrichedModels.push(enriched);
        }
      });

      setModels(enrichedModels);
      setDiscoveryComplete(true);
      
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
  }, [enabledInstanceUrls, instanceLookup, showToast]);

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

  // Auto-discover when modal opens
  useEffect(() => {
    if (isOpen && !discoveryComplete && !loading) {
      discoverModels();
    }
  }, [isOpen, discoveryComplete, loading, discoverModels]);

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
                onClick={discoverModels}
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
                <Button onClick={discoverModels}>Try Again</Button>
              </div>
            ) : loading ? (
              <div className="p-6 text-center">
                <Loader className="w-12 h-12 text-green-500 mx-auto mb-4 animate-spin" />
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Discovering Models</h3>
                <p className="text-gray-600 dark:text-gray-400 mb-2">
                  {discoveryProgress || `Scanning ${enabledInstanceUrls.length} Ollama instances...`}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500">
                  This may take up to 30 seconds depending on the number of models...
                </p>
                <div className="mt-4">
                  <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                    <div className="bg-green-500 h-full animate-pulse" style={{width: '100%'}}></div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-96 overflow-y-auto p-6">
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
                                      {model.embeddingDimensions}D
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