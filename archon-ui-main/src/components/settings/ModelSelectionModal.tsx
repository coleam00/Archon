import React, { useState, useEffect, useMemo } from 'react';
import { X, Search, Activity, Cpu, Database, Zap, Clock, Star, Download, Loader, Server } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Provider } from './ProviderTileButton';
import { credentialsService } from '../../services/credentialsService';

export interface ModelSpec {
  id: string;
  name: string;
  displayName: string;
  provider: Provider;
  type: 'chat' | 'embedding' | 'vision';
  description?: string;
  contextWindow?: number; // Default/current context window
  maxContextWindow?: number; // Maximum supported context window
  minContextWindow?: number; // Minimum context window
  recommended?: boolean;
  dimensions?: number;
  toolSupport?: boolean;
  performance?: { speed: 'fast' | 'medium' | 'slow'; quality: 'high' | 'medium' | 'low' };
  capabilities?: string[];
  useCase?: string[];
  status?: 'available' | 'downloading' | 'error';
  size_gb?: number;
  family?: string;
  hostInfo?: {
    host: string;
    family?: string;
    size_gb?: number;
    context_window?: number; // Default context window from API
    max_context_window?: number; // Maximum context window from API
    min_context_window?: number; // Minimum context window from API
    supports_tools?: boolean;
    supports_thinking?: boolean;
    embedding_dimensions?: number;
  };
  pricing?: {
    input: number;
    output: number;
    unit: string;
  };
}

interface ModelSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  provider: Provider;
  modelType: 'chat' | 'embedding';
  onSelectModel: (model: ModelSpec) => void;
  selectedModelId?: string;
  loading?: boolean;
}

type SortOption = 'name' | 'contextWindow' | 'performance' | 'pricing';
type SortDirection = 'asc' | 'desc';

const getMockModels = (provider: Provider): ModelSpec[] => {
  const models: Record<Provider, ModelSpec[]> = {
    openai: [
      {
        id: 'gpt-4-turbo',
        name: 'gpt-4-turbo',
        displayName: 'GPT-4 Turbo',
        provider: 'openai',
        type: 'chat',
        description: 'Most capable GPT-4 model with improved instruction following',
        contextWindow: 128000,
        maxContextWindow: 128000,
        minContextWindow: 1024,
        recommended: true,
        toolSupport: true,
        performance: { speed: 'medium', quality: 'high' },
        capabilities: ['Text Generation', 'Function Calling', 'Code Generation'],
        useCase: ['General Purpose', 'Complex Reasoning'],
        status: 'available',
        pricing: { input: 0.01, output: 0.03, unit: '1K tokens' }
      },
      {
        id: 'gpt-4',
        name: 'gpt-4',
        displayName: 'GPT-4',
        provider: 'openai',
        type: 'chat',
        description: 'High-quality reasoning and complex instruction following',
        contextWindow: 8192,
        maxContextWindow: 8192,
        minContextWindow: 1024,
        toolSupport: true,
        performance: { speed: 'slow', quality: 'high' },
        capabilities: ['Text Generation', 'Function Calling'],
        useCase: ['General Purpose'],
        status: 'available',
        pricing: { input: 0.03, output: 0.06, unit: '1K tokens' }
      },
      {
        id: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        displayName: 'Text Embedding 3 Large',
        provider: 'openai',
        type: 'embedding',
        description: 'Most capable embedding model for semantic search',
        contextWindow: 8191,
        maxContextWindow: 8191,
        minContextWindow: 512,
        dimensions: 3072,
        recommended: true,
        performance: { speed: 'fast', quality: 'high' },
        capabilities: ['Text Embeddings', 'Semantic Search'],
        useCase: ['RAG', 'Search'],
        status: 'available',
        pricing: { input: 0.00013, output: 0, unit: '1K tokens' }
      },
      {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        displayName: 'Text Embedding 3 Small',
        provider: 'openai',
        type: 'embedding',
        description: 'Efficient embedding model for most use cases',
        contextWindow: 8191,
        maxContextWindow: 8191,
        minContextWindow: 512,
        dimensions: 1536,
        performance: { speed: 'fast', quality: 'medium' },
        capabilities: ['Text Embeddings'],
        useCase: ['RAG'],
        status: 'available',
        pricing: { input: 0.00002, output: 0, unit: '1K tokens' }
      }
    ],
    google: [
      {
        id: 'gemini-1.5-pro',
        name: 'gemini-1.5-pro',
        displayName: 'Gemini 1.5 Pro',
        provider: 'google',
        type: 'chat',
        description: 'Google\'s most capable multimodal model',
        contextWindow: 1000000,
        maxContextWindow: 2000000,
        minContextWindow: 1024,
        recommended: true,
        toolSupport: true,
        performance: { speed: 'medium', quality: 'high' },
        capabilities: ['Text Generation', 'Vision', 'Function Calling'],
        useCase: ['General Purpose', 'Multimodal'],
        status: 'available'
      },
      {
        id: 'gemini-1.5-flash',
        name: 'gemini-1.5-flash',
        displayName: 'Gemini 1.5 Flash',
        provider: 'google',
        type: 'chat',
        description: 'Fast and efficient with good performance',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        minContextWindow: 1024,
        toolSupport: true,
        performance: { speed: 'fast', quality: 'medium' },
        capabilities: ['Text Generation', 'Function Calling'],
        useCase: ['General Purpose'],
        status: 'available'
      }
    ],
    ollama: [],
    anthropic: [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'claude-3-5-sonnet-20241022',
        displayName: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
        type: 'chat',
        description: 'Anthropic\'s most intelligent model',
        contextWindow: 200000,
        maxContextWindow: 200000,
        minContextWindow: 1024,
        recommended: true,
        toolSupport: true,
        performance: { speed: 'medium', quality: 'high' },
        capabilities: ['Text Generation', 'Function Calling', 'Code Generation'],
        useCase: ['General Purpose', 'Complex Reasoning'],
        status: 'available'
      },
      {
        id: 'claude-3-haiku-20240307',
        name: 'claude-3-haiku-20240307',
        displayName: 'Claude 3 Haiku',
        provider: 'anthropic',
        type: 'chat',
        description: 'Fast and cost-effective for lighter tasks',
        contextWindow: 200000,
        maxContextWindow: 200000,
        minContextWindow: 1024,
        toolSupport: true,
        performance: { speed: 'fast', quality: 'medium' },
        capabilities: ['Text Generation', 'Function Calling'],
        useCase: ['General Purpose'],
        status: 'available'
      }
    ]
  };
  
  return models[provider] || [];
};

export const ModelSelectionModal: React.FC<ModelSelectionModalProps> = ({
  isOpen,
  onClose,
  provider,
  modelType,
  onSelectModel,
  selectedModelId,
  loading = false
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'chat' | 'embedding' | 'vision'>('all');
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [ollamaDiscovery, setOllamaDiscovery] = useState<{
    chat_models: any[];
    embedding_models: any[];
    host_status: Record<string, any>;
    total_models: number;
    discovery_errors: string[];
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Load models when modal opens
  useEffect(() => {
    if (isOpen) {
      loadModels();
    }
  }, [isOpen, provider, refreshKey]);

  // Filter models based on type preference
  useEffect(() => {
    if (modelType) {
      setFilterType(modelType);
    } else {
      setFilterType('all');
    }
  }, [modelType]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      if (provider === 'ollama') {
        // For Ollama, get the configured hosts from database
        const getConfiguredOllamaHosts = async () => {
          try {
            const instances = await credentialsService.getOllamaInstances();
            const enabledHosts = instances
              .filter((inst: any) => inst.isEnabled)
              .map((inst: any) => inst.baseUrl);
            
            if (enabledHosts.length > 0) {
              return enabledHosts;
            }
          } catch (error) {
            console.error('Failed to load Ollama instances from database:', error);
            
            // Fallback to localStorage
            try {
              const saved = localStorage.getItem('ollama-instances');
              if (saved) {
                const localInstances = JSON.parse(saved);
                return localInstances
                  .filter((inst: any) => inst.isEnabled)
                  .map((inst: any) => inst.baseUrl);
              }
            } catch (localError) {
              console.error('Failed to load from localStorage as fallback:', localError);
            }
          }
          // Final fallback to default host
          return ['http://localhost:11434'];
        };
        
        const hosts = await getConfiguredOllamaHosts();
        
        const discoveryData = await credentialsService.discoverOllamaModels(hosts);
        setOllamaDiscovery(discoveryData);
        
        // Convert Ollama models to ModelSpec format with enhanced details
        const allOllamaModels = [
          ...discoveryData.chat_models.map((model: any) => {
            // Enhanced context window calculation
            const defaultContext = model.context_window || 4096;
            const getContextWindowLimits = (contextWindow: number, modelName: string) => {
              const name = modelName.toLowerCase();
              let minContext = 1024; // Standard minimum
              let maxContext = contextWindow;
              
              // Estimate max context based on model capabilities
              if (name.includes('llama3') || name.includes('llama-3')) {
                maxContext = Math.max(contextWindow, 8192);
              } else if (name.includes('qwen')) {
                maxContext = Math.max(contextWindow, 32768);
              } else if (name.includes('mistral')) {
                maxContext = Math.max(contextWindow, 32768);
              } else if (name.includes('gemma')) {
                maxContext = Math.max(contextWindow, 8192);
              } else if (name.includes('phi')) {
                maxContext = Math.max(contextWindow, 4096);
              } else {
                // For unknown models, assume some expandability
                maxContext = Math.max(contextWindow, contextWindow * 2);
              }
              
              return { minContext, maxContext };
            };
            
            const { minContext, maxContext } = getContextWindowLimits(defaultContext, model.name);
            
            return {
              id: `${model.name}@${model.host}`,
              name: model.name,
              displayName: model.name,
              provider: 'ollama' as Provider,
              type: 'chat' as const,
              contextWindow: defaultContext,
              maxContextWindow: maxContext,
              minContextWindow: minContext,
              toolSupport: model.supports_tools,
              performance: { speed: 'medium', quality: 'high' },
              capabilities: [
                'Text Generation', 
                'Local Processing',
                ...(model.supports_tools ? ['Function Calling'] : []),
                ...(model.supports_thinking ? ['Thinking'] : [])
              ],
              useCase: ['Local AI', 'Privacy', 'Offline Processing'],
              status: 'available' as const,
              description: `${model.family || 'Ollama'} model running on ${new URL(model.host).hostname}`,
              size_gb: model.size_gb,
              family: model.family,
              hostInfo: {
                host: model.host,
                family: model.family,
                size_gb: model.size_gb,
                context_window: defaultContext,
                max_context_window: maxContext,
                min_context_window: minContext,
                supports_tools: model.supports_tools,
                supports_thinking: model.supports_thinking,
              },
            };
          }),
          ...discoveryData.embedding_models.map((model: any) => {
            const defaultContext = model.context_window || 512;
            const maxContext = Math.max(defaultContext, 2048); // Embedding models typically have smaller context windows
            const minContext = 128;
            
            return {
              id: `${model.name}@${model.host}`,
              name: model.name,
              displayName: model.name,
              provider: 'ollama' as Provider,
              type: 'embedding' as const,
              contextWindow: defaultContext,
              maxContextWindow: maxContext,
              minContextWindow: minContext,
              dimensions: model.embedding_dimensions,
              toolSupport: false,
              performance: { speed: 'fast', quality: 'medium' },
              capabilities: ['Text Embeddings', 'Local Processing', 'Semantic Search'],
              useCase: ['Private Search', 'Local RAG', 'Offline Embeddings'],
              status: 'available' as const,
              description: `${model.family || 'Embedding'} model (${model.embedding_dimensions}D) on ${new URL(model.host).hostname}`,
              size_gb: model.size_gb,
              family: model.family,
              hostInfo: {
                host: model.host,
                family: model.family,
                size_gb: model.size_gb,
                context_window: defaultContext,
                max_context_window: maxContext,
                min_context_window: minContext,
                embedding_dimensions: model.embedding_dimensions,
              },
              };
            }),
        ];

        setModels(allOllamaModels);
      } else {
        // For other providers, use mock data since we don't have API endpoints yet
        setModels(getMockModels(provider));
      }
    } catch (error) {
      console.error('Error loading models:', error);
      // Fall back to mock data if API fails
      setModels(getMockModels(provider));
    } finally {
      setLoadingModels(false);
    }
  };

  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1);
  };

  // Helper function to get embedding-specific use case tags based on dimensions
  const getEmbeddingUseCaseTags = (dimensions: number, modelName: string) => {
    const tags: string[] = [];
    
    // Dimension-based tags
    if (dimensions > 2000) {
      tags.push('High Precision', 'Complex Queries');
    } else if (dimensions >= 1000) {
      tags.push('Balanced', 'General Purpose');
    } else {
      tags.push('Fast', 'Resource Efficient');
    }
    
    // Model family-specific tags
    const name = modelName.toLowerCase();
    if (name.includes('all-minilm')) {
      tags.push('Semantic Search', 'Document Similarity');
    } else if (name.includes('all-mpnet')) {
      tags.push('RAG', 'High Quality');
    } else if (name.includes('bge') || name.includes('gte')) {
      tags.push('Multilingual', 'Code Search');
    } else if (name.includes('e5')) {
      tags.push('Text Retrieval', 'Cross-lingual');
    } else if (name.includes('instructor')) {
      tags.push('Instruction-based', 'Versatile');
    } else if (name.includes('nomic')) {
      tags.push('Variable Length', 'Flexible');
    } else {
      // Generic embedding tags
      tags.push('Semantic Search', 'RAG');
    }
    
    return tags;
  };

  // Helper function to get support level colors
  const getSupportColor = (supported: boolean | undefined, level: 'full' | 'partial' | 'none' = supported === true ? 'full' : 'none') => {
    switch (level) {
      case 'full':
        return 'text-green-400 border-green-500/30 bg-green-500/10';
      case 'partial':
        return 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10';
      case 'none':
      default:
        return 'text-gray-400 border-gray-500/30 bg-gray-500/10';
    }
  };

  // Helper function to get performance colors
  const getPerformanceColor = (value: string, type: 'speed' | 'quality') => {
    if (type === 'speed') {
      switch (value) {
        case 'fast': return 'text-green-400';
        case 'medium': return 'text-yellow-400';
        case 'slow': return 'text-red-400';
        default: return 'text-gray-400';
      }
    } else { // quality
      switch (value) {
        case 'high': return 'text-green-400';
        case 'medium': return 'text-yellow-400';
        case 'low': return 'text-red-400';
        default: return 'text-gray-400';
      }
    }
  };

  // Helper function to render support indicator dot
  const SupportDot = ({ supported, level = supported === true ? 'full' : 'none' }: { supported: boolean | undefined, level?: 'full' | 'partial' | 'none' }) => {
    const colorClass = level === 'full' ? 'bg-green-400' : level === 'partial' ? 'bg-yellow-400' : 'bg-gray-500';
    return <div className={`w-2 h-2 rounded-full ${colorClass}`} />;
  };

  // Helper function to determine support level for sorting
  const getModelSupportLevel = (model: ModelSpec) => {
    // For Ollama models, we can infer support levels from capabilities and tools
    if (model.provider === 'ollama') {
      const hasTools = model.toolSupport || model.hostInfo?.supports_tools;
      const hasThinking = model.hostInfo?.supports_thinking;
      const hasAdvancedFeatures = model.capabilities?.includes('Function Calling') || 
                                  model.capabilities?.includes('Thinking');
      
      if (hasTools && (hasThinking || hasAdvancedFeatures)) return 'full';
      if (hasTools || hasAdvancedFeatures) return 'partial';
      return 'limited';
    }
    
    // For other providers, assume full support for recommended models, partial otherwise
    if (model.recommended) return 'full';
    if (model.toolSupport) return 'partial';
    return 'limited';
  };

  // Filter and sort models
  const filteredAndSortedModels = useMemo(() => {
    let filtered = models.filter(model => {
      // Text search filter
      const matchesSearch = !searchQuery || 
        model.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        model.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        model.capabilities?.some(cap => cap.toLowerCase().includes(searchQuery.toLowerCase()));

      // Type filter
      const matchesType = filterType === 'all' || model.type === filterType;

      return matchesSearch && matchesType;
    });

    // Sort models with priority-based sorting
    filtered.sort((a, b) => {
      // Primary sort: Support level (full → partial → limited)
      const supportOrder = { 'full': 3, 'partial': 2, 'limited': 1 };
      const aSupportLevel = supportOrder[getModelSupportLevel(a)] || 1;
      const bSupportLevel = supportOrder[getModelSupportLevel(b)] || 1;
      
      if (aSupportLevel !== bSupportLevel) {
        return bSupportLevel - aSupportLevel; // Higher support levels first
      }

      // Secondary sort: Recommended models first within same support level
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;

      // Tertiary sort: User-selected sort option
      let aVal: any, bVal: any;
      
      switch (sortBy) {
        case 'name':
          aVal = a.displayName.toLowerCase();
          bVal = b.displayName.toLowerCase();
          break;
        case 'contextWindow':
          aVal = a.contextWindow || 0;
          bVal = b.contextWindow || 0;
          break;
        case 'performance':
          const speedOrder = { fast: 3, medium: 2, slow: 1 };
          const qualityOrder = { high: 3, medium: 2, low: 1 };
          aVal = speedOrder[a.performance?.speed || 'medium'] + qualityOrder[a.performance?.quality || 'medium'];
          bVal = speedOrder[b.performance?.speed || 'medium'] + qualityOrder[b.performance?.quality || 'medium'];
          break;
        case 'pricing':
          aVal = a.pricing?.input || 0;
          bVal = b.pricing?.input || 0;
          break;
        default:
          // Default to alphabetical by name
          aVal = a.displayName.toLowerCase();
          bVal = b.displayName.toLowerCase();
          break;
      }

      // Apply sort direction
      if (sortDirection === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });

    return filtered;
  }, [models, searchQuery, filterType, sortBy, sortDirection]);

  const handleSort = (option: SortOption) => {
    if (sortBy === option) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(option);
      setSortDirection('asc');
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="relative bg-gray-900/95 border border-gray-800 rounded-xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with gradient accent line */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-green-500 via-blue-500 via-orange-500 to-purple-500 shadow-[0_0_20px_5px_rgba(59,130,246,0.5)]"></div>
        
        {/* Modal Header */}
        <div className="flex justify-between items-center p-6 border-b border-gray-800">
          <div className="flex-1">
            <h2 className="text-2xl font-bold text-blue-400 flex items-center gap-3">
              <Activity className="w-6 h-6" />
              Select {provider.charAt(0).toUpperCase() + provider.slice(1)} Model
            </h2>
            <p className="text-gray-400 mt-1">
              Choose the best model for your needs
              {modelType && <span className="ml-1">({modelType} models)</span>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {provider === 'ollama' && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={loadingModels}
                className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10"
              >
                {loadingModels ? <Loader className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {loadingModels ? 'Loading...' : 'Refresh'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-gray-400 hover:text-white hover:bg-gray-800"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Search and Filters */}
        <div className="p-4 border-b border-gray-800 space-y-4">
          <div className="flex gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <Input
                type="text"
                placeholder="Search models by name, description, or capabilities..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 bg-gray-800/50 border-gray-700 text-white placeholder-gray-400"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant={sortBy === 'name' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => handleSort('name')}
                className="text-xs"
              >
                Name {sortBy === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}
              </Button>
              <Button
                variant={sortBy === 'contextWindow' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => handleSort('contextWindow')}
                className="text-xs"
              >
                Context {sortBy === 'contextWindow' && (sortDirection === 'asc' ? '↑' : '↓')}
              </Button>
              <Button
                variant={sortBy === 'performance' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => handleSort('performance')}
                className="text-xs"
              >
                Performance {sortBy === 'performance' && (sortDirection === 'asc' ? '↑' : '↓')}
              </Button>
            </div>
          </div>

          {/* Ollama Discovery Status */}
          {provider === 'ollama' && ollamaDiscovery && (
            <div className="bg-gray-800/30 rounded-lg p-3">
              <div className="flex items-center gap-4 text-sm">
                <div className="text-orange-400">
                  <Database className="w-4 h-4 inline mr-1" />
                  {ollamaDiscovery.total_models} models found
                </div>
                {ollamaDiscovery.discovery_errors.length > 0 && (
                  <div className="text-red-400">
                    {ollamaDiscovery.discovery_errors.length} connection errors
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Models Grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {loadingModels ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <Loader className="w-8 h-8 animate-spin text-blue-400 mx-auto mb-4" />
                <p className="text-gray-400">Loading models...</p>
              </div>
            </div>
          ) : filteredAndSortedModels.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <Database className="w-16 h-16 text-gray-600 mx-auto mb-4" />
                <h3 className="text-xl font-medium text-gray-400 mb-2">No Models Found</h3>
                <p className="text-gray-500">
                  {provider === 'ollama' 
                    ? 'No Ollama models are available. Make sure Ollama is running and has models installed.'
                    : `No ${modelType} models available for ${provider}`
                  }
                </p>
                {provider === 'ollama' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    className="mt-4 text-orange-400 border-orange-500/30"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Refresh Models
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredAndSortedModels.map((model) => (
                <motion.div
                  key={model.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`relative group cursor-pointer rounded-xl border-2 transition-all duration-300 hover:scale-[1.02] ${
                    selectedModelId === model.id
                      ? 'border-blue-500 bg-blue-500/10 shadow-[0_0_20px_rgba(59,130,246,0.3)]'
                      : 'border-gray-700 bg-gray-800/50 hover:border-gray-600 hover:bg-gray-800/70'
                  }`}
                  onClick={() => onSelectModel(model)}
                >
                  {/* Recommended Badge */}
                  {model.recommended && (
                    <div className="absolute -top-2 -right-2 z-10">
                      <div className="bg-gradient-to-r from-yellow-400 to-orange-500 text-black text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1">
                        <Star className="w-3 h-3" />
                        Recommended
                      </div>
                    </div>
                  )}

                  <div className="p-5">
                    {/* Header */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-lg text-white mb-1 line-clamp-3 leading-tight">
                          {model.displayName}
                        </h3>
                        <div className="flex items-center gap-2 mb-2">
                          <Badge 
                            variant="outline" 
                            className={`text-xs ${
                              model.type === 'chat' ? 'border-green-500/30 text-green-400' :
                              model.type === 'embedding' ? 'border-purple-500/30 text-purple-400' :
                              'border-blue-500/30 text-blue-400'
                            }`}
                          >
                            {model.type}
                          </Badge>
                          {/* Support Level Badge */}
                          {(() => {
                            const supportLevel = getModelSupportLevel(model);
                            const supportConfig = {
                              'full': { color: 'bg-green-500 text-black', text: 'Full Support', icon: '✓' },
                              'partial': { color: 'bg-orange-500 text-black', text: 'Partial', icon: '◐' },
                              'limited': { color: 'bg-red-500 text-white', text: 'Limited', icon: '◯' }
                            };
                            const config = supportConfig[supportLevel];
                            return (
                              <Badge 
                                variant="outline" 
                                className={`text-xs ${config.color} border-transparent font-medium`}
                              >
                                <span className="mr-1">{config.icon}</span>
                                {config.text}
                              </Badge>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* Description */}
                    {model.description && (
                      <p className="text-sm text-gray-400 mb-4 line-clamp-2 leading-relaxed">
                        {model.description}
                      </p>
                    )}

                    {/* Host Information */}
                    {model.hostInfo?.host && (
                      <div className="mb-4 p-3 bg-gray-800/30 border border-gray-700/50 rounded-lg">
                        <div className="flex items-center gap-2 text-sm">
                          <Server className="w-4 h-4 text-orange-400" />
                          <span className="text-gray-300 font-medium">Host:</span>
                          <span className="text-orange-400">{new URL(model.hostInfo.host).hostname}</span>
                        </div>
                      </div>
                    )}

                    {/* Support Indicators */}
                    <div className="mb-4 space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {/* Tool Support */}
                        {(model.toolSupport !== undefined || model.hostInfo?.supports_tools !== undefined) && (
                          <div className={`flex items-center gap-2 px-2 py-1 rounded border ${getSupportColor(model.toolSupport || model.hostInfo?.supports_tools)}`}>
                            <SupportDot supported={model.toolSupport || model.hostInfo?.supports_tools} />
                            <span className="font-medium">Tools</span>
                          </div>
                        )}

                        {/* Thinking Support */}
                        {model.hostInfo?.supports_thinking !== undefined && (
                          <div className={`flex items-center gap-2 px-2 py-1 rounded border ${getSupportColor(model.hostInfo.supports_thinking)}`}>
                            <SupportDot supported={model.hostInfo.supports_thinking} />
                            <span className="font-medium">Thinking</span>
                          </div>
                        )}

                        {/* Vision Support - check capabilities for vision models */}
                        {(model.type === 'vision' || model.capabilities?.includes('Vision')) && (
                          <div className={`flex items-center gap-2 px-2 py-1 rounded border ${getSupportColor(model.capabilities?.includes('Vision'))}`}>
                            <SupportDot supported={model.capabilities?.includes('Vision')} />
                            <span className="font-medium">Vision</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Specs - Conditional Display for Embedding vs Chat Models */}
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        {/* For Chat Models - Show Context Window */}
                        {model.type === 'chat' && model.contextWindow && (
                          <div className="flex items-center gap-1 text-cyan-400 col-span-2">
                            <Cpu className="w-3 h-3" />
                            <span className="font-medium">
                              Context: {(() => {
                                const current = model.contextWindow || 0;
                                const max = model.maxContextWindow || model.hostInfo?.max_context_window || current;
                                const min = model.minContextWindow || model.hostInfo?.min_context_window || Math.min(current, 1024);
                                
                                const formatNumber = (num: number) => {
                                  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
                                  if (num >= 1000) return `${Math.round(num / 1000)}K`;
                                  return num.toString();
                                };
                                
                                // If max is significantly different from current, show both
                                if (max !== current && max > current) {
                                  return `${formatNumber(current)} / ${formatNumber(max)} max`;
                                }
                                
                                // If current and max are same but different from min, show as max
                                if (current === max && current > min) {
                                  return `${formatNumber(current)} tokens (max)`;
                                }
                                
                                // If all values are the same or very close, show simple format
                                if (Math.abs(current - max) < current * 0.1) {
                                  return `${formatNumber(current)} tokens`;
                                }
                                
                                // Default format showing current and max
                                return `${formatNumber(current)} / ${formatNumber(max)} max`;
                              })()}
                            </span>
                          </div>
                        )}

                        {/* For Embedding Models - Show Dimensions Prominently */}
                        {model.type === 'embedding' && model.dimensions && (
                          <div className="flex items-center gap-1 text-purple-400 col-span-2">
                            <Database className="w-4 h-4" />
                            <span className="font-semibold text-base">
                              {model.dimensions} dimensions
                            </span>
                          </div>
                        )}

                        {/* Model Size in GB (for all models) */}
                        {model.size_gb && (
                          <div className="flex items-center gap-1 text-orange-400">
                            <Download className="w-3 h-3" />
                            <span>{model.size_gb}GB</span>
                          </div>
                        )}

                        {/* Performance indicators (for all models) */}
                        {model.performance && (
                          <>
                            <div className={`flex items-center gap-1 ${getPerformanceColor(model.performance.speed, 'speed')}`}>
                              <Zap className="w-3 h-3" />
                              <span>Speed: {model.performance.speed}</span>
                            </div>
                            <div className={`flex items-center gap-1 ${getPerformanceColor(model.performance.quality, 'quality')}`}>
                              <Clock className="w-3 h-3" />
                              <span>Quality: {model.performance.quality}</span>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Capabilities - Enhanced for Embedding Models */}
                      {model.capabilities && model.capabilities.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {/* For embedding models, show dimension-based and specialized tags */}
                          {model.type === 'embedding' && model.dimensions ? (
                            getEmbeddingUseCaseTags(model.dimensions, model.displayName).slice(0, 4).map((tag, index) => {
                              // Color code embedding-specific capabilities
                              let capColorClass = "text-gray-300 border-gray-600 bg-gray-700/50";
                              if (tag === 'High Precision' || tag === 'High Quality') capColorClass = "text-green-300 border-green-600/30 bg-green-700/20";
                              else if (tag === 'Fast' || tag === 'Resource Efficient') capColorClass = "text-blue-300 border-blue-600/30 bg-blue-700/20";
                              else if (tag === 'Semantic Search' || tag === 'RAG') capColorClass = "text-purple-300 border-purple-600/30 bg-purple-700/20";
                              else if (tag === 'Code Search' || tag === 'Multilingual') capColorClass = "text-orange-300 border-orange-600/30 bg-orange-700/20";
                              else if (tag === 'Balanced' || tag === 'General Purpose') capColorClass = "text-yellow-300 border-yellow-600/30 bg-yellow-700/20";
                              
                              return (
                                <Badge
                                  key={index}
                                  variant="outline"
                                  className={`text-xs ${capColorClass}`}
                                >
                                  {tag}
                                </Badge>
                              );
                            })
                          ) : (
                            /* For non-embedding models, show regular capabilities */
                            model.capabilities.slice(0, 3).map((cap, index) => {
                              // Color code capabilities based on type
                              let capColorClass = "text-gray-300 border-gray-600 bg-gray-700/50";
                              if (cap === 'Function Calling') capColorClass = "text-green-300 border-green-600/30 bg-green-700/20";
                              else if (cap === 'Thinking') capColorClass = "text-blue-300 border-blue-600/30 bg-blue-700/20";
                              else if (cap === 'Vision') capColorClass = "text-purple-300 border-purple-600/30 bg-purple-700/20";
                              else if (cap === 'Local Processing') capColorClass = "text-orange-300 border-orange-600/30 bg-orange-700/20";
                              
                              return (
                                <Badge
                                  key={index}
                                  variant="outline"
                                  className={`text-xs ${capColorClass}`}
                                >
                                  {cap}
                                </Badge>
                              );
                            })
                          )}
                          {/* Show overflow indicator if there are more capabilities/tags */}
                          {((model.type === 'embedding' && model.dimensions && getEmbeddingUseCaseTags(model.dimensions, model.displayName).length > 4) ||
                            (model.type !== 'embedding' && model.capabilities.length > 3)) && (
                            <Badge variant="outline" className="text-xs bg-gray-700/50 border-gray-600 text-gray-300">
                              +{model.type === 'embedding' && model.dimensions 
                                ? getEmbeddingUseCaseTags(model.dimensions, model.displayName).length - 4
                                : model.capabilities.length - 3}
                            </Badge>
                          )}
                        </div>
                      )}

                      {/* Pricing */}
                      {model.pricing && (
                        <div className="text-xs text-gray-400">
                          <span className="text-green-400">${model.pricing.input}</span>
                          /<span className="text-blue-400">${model.pricing.output}</span> per {model.pricing.unit}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Selected indicator */}
                  {selectedModelId === model.id && (
                    <div className="absolute inset-0 border-2 border-blue-500 rounded-xl pointer-events-none">
                      <div className="absolute top-3 right-3 w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                        <div className="w-2 h-2 bg-white rounded-full" />
                      </div>
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center p-6 border-t border-gray-800">
          <div className="text-sm text-gray-400">
            {filteredAndSortedModels.length} model{filteredAndSortedModels.length !== 1 ? 's' : ''} available
          </div>
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={onClose}
              className="border-gray-600 text-gray-300 hover:bg-gray-800"
            >
              Cancel
            </Button>
            <Button
              onClick={() => selectedModelId && onSelectModel(filteredAndSortedModels.find(m => m.id === selectedModelId)!)}
              disabled={!selectedModelId || loading}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {loading ? (
                <>
                  <Loader className="w-4 h-4 animate-spin mr-2" />
                  Selecting...
                </>
              ) : (
                'Select Model'
              )}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
};
