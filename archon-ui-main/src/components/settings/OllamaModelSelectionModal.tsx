import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { X, Search, RotateCcw, Zap, Server, Eye, Settings, Download, Box } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useToast } from '../../contexts/ToastContext';

interface ContextInfo {
  current?: number;
  max?: number;
  min?: number;
}

interface ModelInfo {
  name: string;
  host: string;
  model_type: 'chat' | 'embedding' | 'multimodal';
  size_mb?: number;
  context_length?: number;
  context_info?: ContextInfo;
  embedding_dimensions?: number;
  parameters?: string | {
    family?: string;
    parameter_size?: string;
    quantization?: string;
    format?: string;
  };
  capabilities: string[];
  archon_compatibility: 'full' | 'partial' | 'limited';
  compatibility_features: string[];
  limitations: string[];
  performance_rating?: 'high' | 'medium' | 'low';
  description?: string;
  last_updated: string;
  // Real API data from /api/show endpoint
  context_window?: number;
  max_context_length?: number;
  base_context_length?: number;
  custom_context_length?: number;
  architecture?: string;
  format?: string;
  parent_model?: string;
  instance_url?: string;
}

interface OllamaModelSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  instances: Array<{ name: string; url: string }>;
  currentModel?: string;
  modelType: 'chat' | 'embedding';
  onSelectModel: (modelName: string) => void;
  selectedInstanceUrl: string;  // The specific instance to show models from
}

interface CompatibilityBadgeProps {
  level: 'full' | 'partial' | 'limited';
  className?: string;
}

const CompatibilityBadge: React.FC<CompatibilityBadgeProps> = ({ level, className = '' }) => {
  const badgeConfig = {
    full: { color: 'bg-green-500', text: 'Archon Ready', icon: '✓' },
    partial: { color: 'bg-orange-500', text: 'Partial Support', icon: '◐' },
    limited: { color: 'bg-red-500', text: 'Limited', icon: '◯' }
  };

  const config = badgeConfig[level];

  return (
    <div className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium text-white ${config.color} ${className}`}>
      <span className="mr-1">{config.icon}</span>
      {config.text}
    </div>
  );
};

// Component to show embedding dimensions with color coding - positioned as badge in upper right
const DimensionBadge: React.FC<{ dimensions: number }> = ({ dimensions }) => {
  let colorClass = 'bg-blue-600';
  
  if (dimensions >= 3072) {
    colorClass = 'bg-purple-600';
  } else if (dimensions >= 1536) {
    colorClass = 'bg-indigo-600';
  } else if (dimensions >= 1024) {
    colorClass = 'bg-green-600';
  } else if (dimensions >= 768) {
    colorClass = 'bg-yellow-600';
  } else {
    colorClass = 'bg-gray-600';
  }

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium text-white ${colorClass}`}>
      {dimensions}D
    </span>
  );
};

interface ModelCardProps {
  model: ModelInfo;
  isSelected: boolean;
  onSelect: () => void;
}

const ModelCard: React.FC<ModelCardProps> = ({ model, isSelected, onSelect }) => {
  // DEBUG: Log model data when rendering each card
  console.log(`🎨 DEBUG: Rendering card for ${model.name}:`, {
    context_info: model.context_info,
    context_window: model.context_window,
    max_context_length: model.max_context_length,
    base_context_length: model.base_context_length,
    custom_context_length: model.custom_context_length,
    architecture: model.architecture,
    parent_model: model.parent_model,
    capabilities: model.capabilities
  });

  const getCardBorderColor = () => {
    switch (model.archon_compatibility) {
      case 'full': return 'border-green-500/50';
      case 'partial': return 'border-orange-500/50';
      case 'limited': return 'border-red-500/50';
      default: return 'border-gray-500/50';
    }
  };

  const formatFileSize = (sizeInMB?: number) => {
    if (!sizeInMB || sizeInMB <= 0) return 'Unknown';
    if (sizeInMB >= 1000) {
      return `${(sizeInMB / 1000).toFixed(1)}GB`;
    }
    return `${sizeInMB}MB`;
  };

  const formatContext = (tokens?: number) => {
    if (!tokens || tokens <= 0) return 'Unknown';
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(0)}K`;
    }
    return `${tokens}`;
  };

  const formatContextDetails = (model: ModelInfo) => {
    const contextInfo = model.context_info;
    
    // For models with comprehensive context_info, show all 3 data points
    if (contextInfo) {
      const current = contextInfo.current;
      const max = contextInfo.max;  
      const base = contextInfo.min; // This is base_context_length from backend
      
      // Build comprehensive context display
      const parts = [];
      
      if (current) {
        parts.push(`Current: ${formatContext(current)}`);
      }
      
      if (max && max !== current) {
        parts.push(`Max: ${formatContext(max)}`);
      }
      
      if (base && base !== current && base !== max) {
        parts.push(`Base: ${formatContext(base)}`);
      }
      
      if (parts.length > 0) {
        return parts.join(' | ');
      }
    }
    
    // Fallback to legacy context_length field
    const current = model.context_length;
    if (current) {
      return `Context: ${formatContext(current)}`;
    }
    
    return 'Unknown';
  };

  return (
    <div 
      className={`relative bg-gray-800/50 rounded-xl p-4 border-2 transition-all duration-300 cursor-pointer hover:shadow-lg hover:scale-[1.02] ${
        isSelected ? `${getCardBorderColor()} ring-2 ring-blue-400 shadow-[0_0_20px_rgba(59,130,246,0.3)]` : `${getCardBorderColor()} hover:border-gray-600 hover:bg-gray-800/70`
      }`}
      onClick={onSelect}
    >
      {/* Top-right badges */}
      <div className="absolute top-3 right-3 flex gap-2">
        {/* Embedding Dimensions Badge */}
        {model.model_type === 'embedding' && model.embedding_dimensions && (
          <DimensionBadge dimensions={model.embedding_dimensions} />
        )}
        {/* Compatibility Badge - only for chat models */}
        {model.model_type === 'chat' && (
          <CompatibilityBadge level={model.archon_compatibility} />
        )}
      </div>

      {/* Model Name and Type */}
      <div className="mb-3">
        <h3 className="text-white font-semibold text-lg mb-1">{model.name}</h3>
        <div className="flex items-center justify-between">
          <span className="text-gray-400 text-sm capitalize">{model.model_type}</span>
          
          {/* Capabilities Tags */}
          {model.capabilities && model.capabilities.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {model.capabilities.map((capability: string) => (
                <span
                  key={capability}
                  className="px-2 py-1 bg-blue-600/20 border border-blue-500/30 rounded-md text-xs text-blue-300 font-medium"
                >
                  {capability}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Model Description - only show if available */}
      {model.description && (
        <p className="text-gray-400 text-sm mb-3 line-clamp-2">
          {model.description}
        </p>
      )}

      {/* Performance Metrics - flexible layout */}
      <div className="border-t border-gray-600 pt-3">
        <div className="flex flex-wrap gap-4 text-xs">
          {/* Context - only show for chat models */}
          {model.model_type === 'chat' && model.context_length && (
            <div className="flex items-center">
              <Eye className="w-3 h-3 text-blue-400 mr-1" />
              <span className="text-gray-300">Context: </span>
              <span className="text-blue-400 ml-1">{formatContextDetails(model)}</span>
            </div>
          )}

          {/* Size - only show if available */}
          {model.size_mb && (
            <div className="flex items-center">
              <Download className="w-3 h-3 text-gray-400 mr-1" />
              <span className="text-gray-300">Size: </span>
              <span className="text-white ml-1">{formatFileSize(model.size_mb)}</span>
            </div>
          )}

          {/* Parameters - show if available */}
          {model.parameters && (
            <div className="flex items-center">
              <Settings className="w-3 h-3 text-green-400 mr-1" />
              <span className="text-gray-300">Params: </span>
              <span className="text-green-400 ml-1">
                {typeof model.parameters === 'object' 
                  ? `${model.parameters.parameter_size || 'Unknown size'} ${model.parameters.quantization ? `(${model.parameters.quantization})` : ''}`.trim()
                  : model.parameters
                }
              </span>
            </div>
          )}

          {/* Context Windows - show all 3 data points if available from real API data */}
          {model.context_info && (model.context_info.current || model.context_info.max || model.context_info.min) && (
            <div className="flex items-center flex-wrap gap-2">
              <span className="w-3 h-3 text-blue-400 mr-1">📏</span>
              <div className="flex gap-2 text-xs">
                {model.context_info.current && (
                  <div>
                    <span className="text-gray-400">Current: </span>
                    <span className="text-blue-400">
                      {model.context_info.current >= 1000000 
                        ? `${(model.context_info.current / 1000000).toFixed(1)}M`
                        : model.context_info.current >= 1000 
                        ? `${Math.round(model.context_info.current / 1000)}K`
                        : `${model.context_info.current}`
                      }
                    </span>
                  </div>
                )}
                {model.context_info.max && model.context_info.max !== model.context_info.current && (
                  <div>
                    <span className="text-gray-400">Max: </span>
                    <span className="text-blue-400">
                      {model.context_info.max >= 1000000 
                        ? `${(model.context_info.max / 1000000).toFixed(1)}M`
                        : model.context_info.max >= 1000 
                        ? `${Math.round(model.context_info.max / 1000)}K`
                        : `${model.context_info.max}`
                      }
                    </span>
                  </div>
                )}
                {model.context_info.min && model.context_info.min !== model.context_info.current && model.context_info.min !== model.context_info.max && (
                  <div>
                    <span className="text-gray-400">Base: </span>
                    <span className="text-blue-400">
                      {model.context_info.min >= 1000000 
                        ? `${(model.context_info.min / 1000000).toFixed(1)}M`
                        : model.context_info.min >= 1000 
                        ? `${Math.round(model.context_info.min / 1000)}K`
                        : `${model.context_info.min}`
                      }
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Architecture - show if available */}
          {model.architecture && (
            <div className="flex items-center">
              <span className="w-3 h-3 text-purple-400 mr-1">🏗️</span>
              <span className="text-gray-300">Arch: </span>
              <span className="text-purple-400 ml-1 capitalize">{model.architecture}</span>
            </div>
          )}

          {/* Format - show if available */}
          {(model.format || model.parameters?.format) && (
            <div className="flex items-center">
              <span className="w-3 h-3 text-cyan-400 mr-1">📦</span>
              <span className="text-gray-300">Format: </span>
              <span className="text-cyan-400 ml-1 uppercase">{model.format || model.parameters?.format}</span>
            </div>
          )}

          {/* Parent Model - show if available */}
          {model.parent_model && (
            <div className="flex items-center">
              <span className="w-3 h-3 text-yellow-400 mr-1">🔗</span>
              <span className="text-gray-300">Base: </span>
              <span className="text-yellow-400 ml-1">{model.parent_model}</span>
            </div>
          )}

        </div>
      </div>

    </div>
  );
};

export const OllamaModelSelectionModal: React.FC<OllamaModelSelectionModalProps> = ({
  isOpen,
  onClose,
  instances,
  currentModel,
  modelType,
  onSelectModel,
  selectedInstanceUrl
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>(currentModel || '');
  const [compatibilityFilter, setCompatibilityFilter] = useState<'all' | 'full' | 'partial' | 'limited'>('all');
  const [sortBy, setSortBy] = useState<'name' | 'context' | 'performance'>('name');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedFromCache, setLoadedFromCache] = useState(false);
  const [cacheTimestamp, setCacheTimestamp] = useState<string | null>(null);
  const { showToast } = useToast();

  // Filter and sort models
  const filteredModels = useMemo(() => {
    console.log('🚨 FILTERING DEBUG: Starting model filtering', {
      modelsCount: models.length,
      models: models.map(m => ({ 
        name: m.name, 
        host: m.host, 
        model_type: m.model_type, 
        archon_compatibility: m.archon_compatibility,
        instance_url: m.instance_url
      })),
      selectedInstanceUrl,
      modelType,
      searchTerm,
      compatibilityFilter,
      timestamp: new Date().toISOString()
    });
    
    console.log('🚨 HOST COMPARISON DEBUG:', {
      selectedInstanceUrl,
      modelHosts: models.map(m => m.host),
      exactMatches: models.filter(m => m.host === selectedInstanceUrl).length
    });
    
    let filtered = models.filter(model => {
      // Filter by selected host
      if (selectedInstanceUrl && model.host !== selectedInstanceUrl) {
        return false;
      }

      // Filter by model type
      if (modelType === 'chat' && model.model_type !== 'chat') return false;
      if (modelType === 'embedding' && model.model_type !== 'embedding') return false;

      // Filter by search term
      if (searchTerm && !model.name.toLowerCase().includes(searchTerm.toLowerCase())) {
        return false;
      }

      // Filter by compatibility
      if (compatibilityFilter !== 'all' && model.archon_compatibility !== compatibilityFilter) {
        return false;
      }

      return true;
    });

    // Sort models with priority-based sorting
    filtered.sort((a, b) => {
      // Primary sort: Support level (full → partial → limited)
      const supportOrder = { 'full': 3, 'partial': 2, 'limited': 1 };
      const aSupportLevel = supportOrder[a.archon_compatibility] || 1;
      const bSupportLevel = supportOrder[b.archon_compatibility] || 1;
      
      if (aSupportLevel !== bSupportLevel) {
        return bSupportLevel - aSupportLevel; // Higher support levels first
      }

      // Secondary sort: User-selected sort option within same support level
      switch (sortBy) {
        case 'context':
          const contextDiff = (b.context_length || 0) - (a.context_length || 0);
          if (contextDiff !== 0) return contextDiff;
          break;
        case 'performance':
          // Performance sorting removed - will be implemented via external data sources
          // For now, fall through to name sorting
          break;
        default:
          // For 'name' and fallback, use alphabetical
          break;
      }

      // Tertiary sort: Always alphabetical by name as final tiebreaker
      return a.name.localeCompare(b.name);
    });

    console.log('🚨 FILTERING DEBUG: Filtering complete', {
      originalCount: models.length,
      filteredCount: filtered.length,
      filtered: filtered.map(m => ({ name: m.name, host: m.host, model_type: m.model_type })),
      timestamp: new Date().toISOString()
    });
    
    return filtered;
  }, [models, searchTerm, compatibilityFilter, sortBy, modelType, selectedInstanceUrl]);

  // Helper functions for compatibility features
  const getCompatibilityFeatures = (compatibility: 'full' | 'partial' | 'limited'): string[] => {
    switch (compatibility) {
      case 'full':
        return ['Real-time streaming', 'Function calling', 'JSON mode', 'Tool integration', 'Advanced prompting'];
      case 'partial':
        return ['Basic streaming', 'Standard prompting', 'Text generation'];
      case 'limited':
        return ['Basic functionality only'];
      default:
        return [];
    }
  };

  const getCompatibilityLimitations = (compatibility: 'full' | 'partial' | 'limited'): string[] => {
    switch (compatibility) {
      case 'full':
        return [];
      case 'partial':
        return ['Limited advanced features', 'May require specific prompting'];
      case 'limited':
        return ['Basic functionality only', 'Limited feature support', 'May have performance constraints'];
      default:
        return [];
    }
  };

  // Load models - first try cache, then fetch from instance
  const loadModels = async (forceRefresh: boolean = false) => {
    try {
      setLoading(true);
      
      // Check session storage cache first (unless force refresh)
      const cacheKey = `ollama_models_${selectedInstanceUrl}_${modelType}`;
      
      if (forceRefresh) {
        console.log(`🔥 Force refresh: Clearing cache for ${cacheKey}`);
        sessionStorage.removeItem(cacheKey);
      }
      
      const cachedData = sessionStorage.getItem(cacheKey);
      const cacheExpiry = 5 * 60 * 1000; // 5 minutes cache
      
      if (cachedData && !forceRefresh) {
        const parsed = JSON.parse(cachedData);
        const age = Date.now() - parsed.timestamp;
        
        if (age < cacheExpiry) {
          // Use cached data
          setModels(parsed.models);
          setLoadedFromCache(true);
          setCacheTimestamp(new Date(parsed.timestamp).toLocaleTimeString());
          setLoading(false);
          console.log(`✅ Loaded ${parsed.models.length} ${modelType} models from cache (age: ${Math.round(age/1000)}s)`);
          return;
        }
      }
      
      // Cache miss or expired - fetch from instance
      console.log(`🔄 Fetching fresh ${modelType} models for ${selectedInstanceUrl}`);
      const instanceUrl = instances.find(i => i.url.replace('/v1', '') === selectedInstanceUrl)?.url || selectedInstanceUrl + '/v1';
      
      // Use the dynamic discovery API with fetch_details to get comprehensive data
      const params = new URLSearchParams();
      params.append('instance_urls', instanceUrl);
      params.append('include_capabilities', 'true');
      params.append('fetch_details', 'true');  // CRITICAL: This triggers /api/show calls for comprehensive data
      
      const response = await fetch(`/api/ollama/models?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        
        // Helper function to determine real compatibility based on model characteristics
        const getArchonCompatibility = (model: any, modelType: string): 'full' | 'partial' | 'limited' => {
          if (modelType === 'chat') {
            // Chat model compatibility based on name patterns and capabilities
            const modelName = model.name.toLowerCase();
            
            // Well-tested models with full Archon support
            if (modelName.includes('llama') || 
                modelName.includes('mistral') || 
                modelName.includes('phi') ||
                modelName.includes('qwen') ||
                modelName.includes('gemma')) {
              return 'full';
            }
            
            // Experimental or newer models with partial support
            if (modelName.includes('codestral') ||
                modelName.includes('deepseek') ||
                modelName.includes('aya') ||
                model.size > 50 * 1024 * 1024 * 1024) { // Models > 50GB might have issues
              return 'partial';
            }
            
            // Very small models or unknown architectures
            if (model.size < 1 * 1024 * 1024 * 1024) { // Models < 1GB
              return 'limited';
            }
            
            return 'partial'; // Default for unknown models
          } else {
            // Embedding model compatibility based on dimensions
            const dimensions = model.dimensions;
            
            // Standard dimensions with excellent Archon support
            if (dimensions === 768 || dimensions === 1536 || dimensions === 384) {
              return 'full';
            }
            
            // Less common but supported dimensions
            if (dimensions >= 256 && dimensions <= 4096) {
              return 'partial';
            }
            
            // Very unusual dimensions
            return 'limited';
          }
        };
        
        // Convert API response to ModelInfo format
        const allModels: ModelInfo[] = [];
        
        // Process chat models
        if (data.chat_models) {
          data.chat_models.forEach((model: any) => {
            const compatibility = getArchonCompatibility(model, 'chat');
            // DEBUG: Log raw model data from API
            console.log(`🔍 DEBUG: Raw model data for ${model.name}:`, {
              context_window: model.context_window,
              custom_context_length: model.custom_context_length,
              base_context_length: model.base_context_length,
              max_context_length: model.max_context_length,
              architecture: model.architecture,
              parent_model: model.parent_model,
              capabilities: model.capabilities
            });

            // Create context_info object with the 3 comprehensive context data points
            const context_info: ContextInfo = {
              current: model.context_window || model.custom_context_length || model.base_context_length,
              max: model.max_context_length,
              min: model.base_context_length
            };

            // DEBUG: Log context_info object creation
            console.log(`📏 DEBUG: Context info for ${model.name}:`, context_info);

            allModels.push({
              name: model.name,
              host: selectedInstanceUrl,
              model_type: 'chat',
              size_mb: model.size ? Math.round(model.size / 1048576) : undefined,
              parameters: model.parameters,
              capabilities: model.capabilities || ['chat'],
              archon_compatibility: compatibility,
              compatibility_features: getCompatibilityFeatures(compatibility),
              limitations: getCompatibilityLimitations(compatibility),
              last_updated: new Date().toISOString(),
              // Comprehensive context information with all 3 data points
              context_window: model.context_window,
              max_context_length: model.max_context_length,
              base_context_length: model.base_context_length,
              custom_context_length: model.custom_context_length,
              context_length: model.context_window || model.custom_context_length || model.base_context_length,
              context_info: context_info,
              // Real API data from /api/show endpoint
              architecture: model.architecture,
              format: model.format,
              parent_model: model.parent_model
            });
          });
        }
        
        // Process embedding models
        if (data.embedding_models) {
          data.embedding_models.forEach((model: any) => {
            const compatibility = getArchonCompatibility(model, 'embedding');
            
            // DEBUG: Log raw embedding model data from API
            console.log(`🔍 DEBUG: Raw embedding model data for ${model.name}:`, {
              context_window: model.context_window,
              custom_context_length: model.custom_context_length,
              base_context_length: model.base_context_length,
              max_context_length: model.max_context_length,
              embedding_dimensions: model.embedding_dimensions
            });

            // Create context_info object for embedding models if context data available
            const context_info: ContextInfo = {
              current: model.context_window || model.custom_context_length || model.base_context_length,
              max: model.max_context_length,
              min: model.base_context_length
            };

            // DEBUG: Log context_info object creation
            console.log(`📏 DEBUG: Embedding context info for ${model.name}:`, context_info);
            
            allModels.push({
              name: model.name,
              host: selectedInstanceUrl,
              model_type: 'embedding',
              size_mb: model.size ? Math.round(model.size / 1048576) : undefined,
              embedding_dimensions: model.dimensions,
              dimensions: model.dimensions, // Some UI might expect this field name
              capabilities: model.capabilities || ['embedding'],
              archon_compatibility: compatibility,
              compatibility_features: getCompatibilityFeatures(compatibility),
              limitations: getCompatibilityLimitations(compatibility),
              last_updated: new Date().toISOString(),
              // Comprehensive context information
              context_window: model.context_window,
              context_length: model.context_window || model.custom_context_length || model.base_context_length,
              context_info: context_info,
              // Real API data from /api/show endpoint
              architecture: model.architecture,
              block_count: model.block_count,
              attention_heads: model.attention_heads,
              format: model.format,
              parent_model: model.parent_model,
              instance_url: selectedInstanceUrl
            });
          });
        }
        
        // DEBUG: Log final allModels array to see what gets set
        console.log(`🚀 DEBUG: Final allModels array (${allModels.length} models):`, allModels);
        
        setModels(allModels);
        setLoadedFromCache(false);
        setCacheTimestamp(null);
        
        // Cache the results
        sessionStorage.setItem(cacheKey, JSON.stringify({
          models: allModels,
          timestamp: Date.now()
        }));
        
        console.log(`✅ Fetched and cached ${allModels.length} models`);
      } else {
        // Fallback to stored models endpoint
        const response = await fetch('/api/ollama/models/stored');
        if (response.ok) {
          const data = await response.json();
          setModels(data.models || []);
          setLoadedFromCache(false);
        }
      }
    } catch (error) {
      console.error('Failed to load models:', error);
      showToast('Failed to load models', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Refresh models from instances
  const refreshModels = async () => {
    console.log('🚨 MODAL DEBUG: refreshModels called - OllamaModelSelectionModal', {
      timestamp: new Date().toISOString(),
      instancesCount: instances.length
    });
    
    // Clear cache for this instance and model type
    const cacheKey = `ollama_models_${selectedInstanceUrl}_${modelType}`;
    sessionStorage.removeItem(cacheKey);
    setLoadedFromCache(false);
    setCacheTimestamp(null);
    
    try {
      setRefreshing(true);
      // Only discover models from the selected instance, not all instances
      const instanceUrls = selectedInstanceUrl 
        ? [instances.find(i => i.url.replace('/v1', '') === selectedInstanceUrl)?.url || selectedInstanceUrl + '/v1'] 
        : instances.map(instance => instance.url);
      
      console.log('🚨 API CALL DEBUG:', {
        selectedInstanceUrl,
        allInstances: instances,
        instanceUrlsToQuery: instanceUrls,
        timestamp: new Date().toISOString()
      });
      
      // Use the correct API endpoint that provides comprehensive model data
      const instanceUrlParams = instanceUrls.map(url => `instance_urls=${encodeURIComponent(url)}`).join('&');
      const fetchDetailsParam = '&include_capabilities=true&fetch_details=true'; // CRITICAL: fetch_details triggers /api/show
      const response = await fetch(`/api/ollama/models?${instanceUrlParams}${fetchDetailsParam}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();
        console.log('🚨 MODAL DEBUG: POST discover-with-details response:', data);
        
        // Functions to determine real compatibility and performance based on model characteristics
        const getArchonCompatibility = (model: any, modelType: string): 'full' | 'partial' | 'limited' => {
          if (modelType === 'chat') {
            // Chat model compatibility based on name patterns and capabilities
            const modelName = model.name.toLowerCase();
            
            // Well-tested models with full Archon support
            if (modelName.includes('llama') || 
                modelName.includes('mistral') || 
                modelName.includes('phi') ||
                modelName.includes('qwen') ||
                modelName.includes('gemma')) {
              return 'full';
            }
            
            // Experimental or newer models with partial support
            if (modelName.includes('codestral') ||
                modelName.includes('deepseek') ||
                modelName.includes('aya') ||
                model.size > 50 * 1024 * 1024 * 1024) { // Models > 50GB might have issues
              return 'partial';
            }
            
            // Very small models or unknown architectures
            if (model.size < 1 * 1024 * 1024 * 1024) { // Models < 1GB
              return 'limited';
            }
            
            return 'partial'; // Default for unknown models
          } else {
            // Embedding model compatibility based on dimensions
            const dimensions = model.dimensions;
            
            // Standard dimensions with excellent Archon support
            if (dimensions === 768 || dimensions === 1536 || dimensions === 384) {
              return 'full';
            }
            
            // Less common but supported dimensions
            if (dimensions >= 256 && dimensions <= 4096) {
              return 'partial';
            }
            
            // Very unusual dimensions
            return 'limited';
          }
        };

        // Performance rating removed - will be implemented via external data sources in future

        // Compatibility features function removed - no longer needed

        // Handle ModelDiscoveryResponse format
        const allModels = [
          ...(data.chat_models || []).map(model => {
            const compatibility = getArchonCompatibility(model, 'chat');
            
            // DEBUG: Log raw model data from API
            console.log(`🔍 DEBUG [refresh]: Raw model data for ${model.name}:`, {
              context_window: model.context_window,
              custom_context_length: model.custom_context_length,
              base_context_length: model.base_context_length,
              max_context_length: model.max_context_length,
              architecture: model.architecture,
              parent_model: model.parent_model,
              capabilities: model.capabilities
            });

            // Create context_info object with the 3 comprehensive context data points
            const context_info: ContextInfo = {
              current: model.context_window || model.custom_context_length || model.base_context_length,
              max: model.max_context_length,
              min: model.base_context_length
            };

            // DEBUG: Log context_info object creation
            console.log(`📏 DEBUG [refresh]: Context info for ${model.name}:`, context_info);
            
            return {
              ...model, 
              host: model.instance_url.replace('/v1', ''), // Remove /v1 suffix to match selectedInstanceUrl
              model_type: 'chat',
              archon_compatibility: compatibility,
              size_mb: model.size ? Math.round(model.size / 1048576) : undefined, // Convert bytes to MB
              context_length: model.context_window || model.custom_context_length || model.base_context_length,
              context_info: context_info, // Add the comprehensive context info
              parameters: model.parameters, // Preserve parameters field for display
              // Preserve all comprehensive model data from API
              capabilities: model.capabilities || ['chat'],
              compatibility_features: getCompatibilityFeatures(compatibility),
              limitations: getCompatibilityLimitations(compatibility),
              last_updated: new Date().toISOString(),
              // Real API data from /api/show endpoint
              context_window: model.context_window,
              max_context_length: model.max_context_length,
              base_context_length: model.base_context_length,
              custom_context_length: model.custom_context_length,
              architecture: model.architecture,
              format: model.format,
              parent_model: model.parent_model
            };
          }),
          ...(data.embedding_models || []).map(model => {
            const compatibility = getArchonCompatibility(model, 'embedding');
            
            // DEBUG: Log raw embedding model data from API
            console.log(`🔍 DEBUG [refresh]: Raw embedding model data for ${model.name}:`, {
              context_window: model.context_window,
              custom_context_length: model.custom_context_length,
              base_context_length: model.base_context_length,
              max_context_length: model.max_context_length,
              embedding_dimensions: model.embedding_dimensions
            });

            // Create context_info object for embedding models if context data available
            const context_info: ContextInfo = {
              current: model.context_window || model.custom_context_length || model.base_context_length,
              max: model.max_context_length,
              min: model.base_context_length
            };

            // DEBUG: Log context_info object creation
            console.log(`📏 DEBUG [refresh]: Embedding context info for ${model.name}:`, context_info);
            
            return {
              ...model, 
              host: model.instance_url.replace('/v1', ''), // Remove /v1 suffix to match selectedInstanceUrl
              model_type: 'embedding',
              archon_compatibility: compatibility,
              size_mb: model.size ? Math.round(model.size / 1048576) : undefined, // Convert bytes to MB
              context_length: model.context_window || model.custom_context_length || model.base_context_length,
              context_info: context_info, // Add the comprehensive context info
              parameters: model.parameters, // Preserve parameters field for display
              // Preserve all comprehensive model data from API
              capabilities: model.capabilities || ['embedding'],
              compatibility_features: getCompatibilityFeatures(compatibility),
              limitations: getCompatibilityLimitations(compatibility),
              last_updated: new Date().toISOString(),
              // Real API data from /api/show endpoint
              context_window: model.context_window,
              max_context_length: model.max_context_length,
              base_context_length: model.base_context_length,
              custom_context_length: model.custom_context_length,
              architecture: model.architecture,
              format: model.format,
              parent_model: model.parent_model,
              embedding_dimensions: model.embedding_dimensions
            };
          })
        ];
        
        // DEBUG: Log final allModels array to see what gets set
        console.log(`🚀 DEBUG [refresh]: Final allModels array (${allModels.length} models):`, allModels);
        console.log('🚨 MODAL DEBUG: Setting models:', allModels);
        setModels(allModels);
        setLoadedFromCache(false);
        setCacheTimestamp(null);
        
        // Cache the refreshed results
        const cacheKey = `ollama_models_${selectedInstanceUrl}_${modelType}`;
        sessionStorage.setItem(cacheKey, JSON.stringify({
          models: allModels,
          timestamp: Date.now()
        }));
        
        const instanceCount = Object.keys(data.host_status || {}).length;
        showToast(`Refreshed ${data.total_models || 0} models from ${instanceCount} instances`, 'success');
      } else {
        throw new Error('Failed to refresh models');
      }
    } catch (error) {
      console.error('Failed to refresh models:', error);
      showToast('Failed to refresh models', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadModels();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }} onClick={onClose}>
      <div className="bg-gray-900/95 border border-gray-800 rounded-xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header with gradient accent line */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-green-500 via-blue-500 via-orange-500 to-purple-500 shadow-[0_0_20px_5px_rgba(59,130,246,0.5)]"></div>
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <div>
            <h2 className="text-xl font-semibold text-white flex items-center">
              <Zap className="w-5 h-5 text-blue-400 mr-2" />
              Select Ollama Model
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              Choose the best model for your needs ({modelType} models from {selectedInstanceUrl?.replace('http://', '') || 'all hosts'})
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={refreshModels}
              disabled={refreshing}
              className="text-blue-400 border-blue-400"
            >
              <RotateCcw className={`w-4 h-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Search and Filters */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center gap-4 mb-4">
            {/* Search */}
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search models by name, description, or capabilities..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Sort Options */}
            <div className="flex gap-2">
              <Button
                variant={sortBy === 'name' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => setSortBy('name')}
                className="text-white"
              >
                Name
              </Button>
              <Button
                variant={sortBy === 'context' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => setSortBy('context')}
                className="text-white"
              >
                Context ↓
              </Button>
              <Button
                variant={sortBy === 'performance' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => setSortBy('performance')}
                className="text-white"
              >
                Performance
              </Button>
            </div>
          </div>

          {/* Compatibility Filter */}
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-300">Archon Compatibility:</span>
            <div className="flex gap-2">
              <Button
                variant={compatibilityFilter === 'all' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => setCompatibilityFilter('all')}
                className="text-white"
              >
                All
              </Button>
              <Button
                variant={compatibilityFilter === 'full' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => setCompatibilityFilter('full')}
                className="text-green-500 border-green-500"
              >
                ● Full Support
              </Button>
              <Button
                variant={compatibilityFilter === 'partial' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => setCompatibilityFilter('partial')}
                className="text-orange-500 border-orange-500"
              >
                ◐ Partial
              </Button>
              <Button
                variant={compatibilityFilter === 'limited' ? 'solid' : 'outline'}
                size="sm"
                onClick={() => setCompatibilityFilter('limited')}
                className="text-red-500 border-red-500"
              >
                ◯ Limited
              </Button>
            </div>
          </div>
        </div>

        {/* Models Count and Cache Status */}
        <div className="px-6 py-3 border-b border-gray-700">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center text-orange-400">
              <span className="mr-2">📋</span>
              {filteredModels.length} models found
            </div>
            {loadedFromCache && cacheTimestamp && (
              <div className="flex items-center text-gray-400">
                <span className="mr-2">💾</span>
                Cached at {cacheTimestamp}
              </div>
            )}
            {!loadedFromCache && !loading && (
              <div className="flex items-center text-green-400">
                <span className="mr-2">🔄</span>
                Fresh data
              </div>
            )}
          </div>
        </div>

        {/* Models Grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-400">Loading models...</div>
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center text-gray-400">
                <p className="mb-2">No models found</p>
                <Button onClick={refreshModels} variant="outline" size="sm">
                  Refresh Models
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredModels.map((model, index) => (
                <ModelCard
                  key={`${model.name}-${model.host}-${index}`}
                  model={model}
                  isSelected={selectedModel === model.name}
                  onSelect={() => setSelectedModel(model.name)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-700 flex items-center justify-between">
          <div className="text-sm text-gray-400">
            {filteredModels.length > 0 && `${filteredModels.length} models available`}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedModel) {
                  onSelectModel(selectedModel);
                  onClose();
                }
              }}
              disabled={!selectedModel}
              className="bg-blue-500 hover:bg-blue-600"
            >
              Select Model
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default OllamaModelSelectionModal;