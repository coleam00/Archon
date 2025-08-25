/**
 * Model Selection Modal Component
 * 
 * Modal for selecting AI models with rich filtering and search capabilities
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Search,
  X,
  Sparkles,
  Zap,
  DollarSign,
  Brain,
  AlertCircle,
  Check,
  Star,
  Filter,
  ChevronRight,
  Settings2,
  Sliders
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { AvailableModel } from '../../types/cleanProvider';
import type { AgentConfig } from '../../types/agent';

interface ModelSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  models: AvailableModel[];
  currentModel?: string;
  onSelectModel: (model: AvailableModel, config?: {
    temperature?: number;
    maxTokens?: number;
  }) => void;
  agent?: AgentConfig;
  showAdvancedSettings?: boolean;
}

export const ModelSelectionModal: React.FC<ModelSelectionModalProps> = ({
  isOpen,
  onClose,
  models,
  currentModel,
  onSelectModel,
  agent,
  showAdvancedSettings = true
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCostTier, setFilterCostTier] = useState<string>('all');
  const [filterProvider, setFilterProvider] = useState<string>('all');
  const [selectedModel, setSelectedModel] = useState<AvailableModel | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2000);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setFilterCostTier('all');
      setFilterProvider('all');
      setSelectedModel(null);
      setShowSettings(false);
      
      // Find and set current model
      const current = models.find(m => m.model_string === currentModel);
      if (current) {
        setSelectedModel(current);
      }
      
      // Focus search input
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [isOpen, currentModel, models]);

  // Get unique providers and cost tiers
  const uniqueProviders = useMemo(() => {
    const providers = new Set(models.map(m => m.provider));
    return Array.from(providers).sort();
  }, [models]);

  const uniqueCostTiers = useMemo(() => {
    const tiers = new Set(models.map(m => m.cost_tier).filter(Boolean));
    return Array.from(tiers);
  }, [models]);

  // Provider display info
  const getProviderInfo = (provider: string) => {
    const info: Record<string, { name: string; color: string; icon: string }> = {
      openai: { name: 'OpenAI', color: 'text-emerald-400', icon: '🤖' },
      anthropic: { name: 'Anthropic', color: 'text-blue-400', icon: '🧠' },
      google: { name: 'Google', color: 'text-yellow-400', icon: '🔍' },
      mistral: { name: 'Mistral', color: 'text-purple-400', icon: '🌊' },
      meta: { name: 'Meta', color: 'text-blue-500', icon: '🔷' },
      groq: { name: 'Groq', color: 'text-orange-400', icon: '⚡' },
      deepseek: { name: 'DeepSeek', color: 'text-cyan-400', icon: '🔬' },
      ollama: { name: 'Ollama', color: 'text-gray-400', icon: '🦙' },
      openrouter: { name: 'OpenRouter', color: 'text-pink-400', icon: '🌍' },
      cohere: { name: 'Cohere', color: 'text-indigo-400', icon: '🌐' },
      xai: { name: 'xAI', color: 'text-red-400', icon: '✖️' }
    };
    
    return info[provider.toLowerCase()] || {
      name: provider.charAt(0).toUpperCase() + provider.slice(1),
      color: 'text-gray-400',
      icon: '🤖'
    };
  };

  // Cost tier info
  const getCostTierInfo = (tier?: string | null) => {
    switch (tier) {
      case 'free':
        return { label: 'Free', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' };
      case 'low':
        return { label: '$', color: 'text-blue-400', bgColor: 'bg-blue-500/10' };
      case 'medium':
        return { label: '$$', color: 'text-yellow-400', bgColor: 'bg-yellow-500/10' };
      case 'high':
        return { label: '$$$', color: 'text-orange-400', bgColor: 'bg-orange-500/10' };
      default:
        return { label: '', color: 'text-gray-400', bgColor: '' };
    }
  };

  // Filter models
  const filteredModels = useMemo(() => {
    let filtered = [...models];

    // Filter compatible models if agent type specified
    if (agent?.modelType === 'embedding') {
      filtered = filtered.filter(m => m.model_string.includes('embedding'));
    } else if (agent) {
      filtered = filtered.filter(m => !m.model_string.includes('embedding'));
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(m =>
        m.display_name.toLowerCase().includes(query) ||
        m.model.toLowerCase().includes(query) ||
        m.provider.toLowerCase().includes(query)
      );
    }

    // Provider filter
    if (filterProvider !== 'all') {
      filtered = filtered.filter(m => m.provider === filterProvider);
    }

    // Cost tier filter
    if (filterCostTier !== 'all') {
      filtered = filtered.filter(m => m.cost_tier === filterCostTier);
    }

    // Sort by cost tier then name
    filtered.sort((a, b) => {
      if (a.cost_tier === 'free' && b.cost_tier !== 'free') return -1;
      if (a.cost_tier !== 'free' && b.cost_tier === 'free') return 1;
      
      const tierOrder = { 'low': 1, 'medium': 2, 'high': 3 };
      const aTier = tierOrder[a.cost_tier as keyof typeof tierOrder] || 4;
      const bTier = tierOrder[b.cost_tier as keyof typeof tierOrder] || 4;
      if (aTier !== bTier) return aTier - bTier;
      
      return a.display_name.localeCompare(b.display_name);
    });

    return filtered;
  }, [models, searchQuery, filterProvider, filterCostTier, agent]);

  // Group models by provider
  const groupedModels = useMemo(() => {
    const grouped: Record<string, AvailableModel[]> = {};
    filteredModels.forEach(model => {
      if (!grouped[model.provider]) {
        grouped[model.provider] = [];
      }
      grouped[model.provider].push(model);
    });
    return grouped;
  }, [filteredModels]);

  // Format single cost value per 1M tokens
  const formatSingleCost = (costPer1K: number) => {
    // Convert from per 1K to per 1M tokens (multiply by 1000)
    const costPer1M = costPer1K * 1000;
    
    // Format based on the cost magnitude with dollar sign after
    if (costPer1M === 0) return '0$';
    if (costPer1M < 0.01) return `${costPer1M.toFixed(4)}$`;
    if (costPer1M < 1) return `${costPer1M.toFixed(2)}$`;
    if (costPer1M < 10) return `${costPer1M.toFixed(1)}$`;
    return `${Math.round(costPer1M)}$`;
  };

  // Handle model selection
  const handleSelectModel = () => {
    if (selectedModel) {
      const config = showSettings && showAdvancedSettings ? {
        temperature: agent?.supportsTemperature ? temperature : undefined,
        maxTokens: agent?.supportsMaxTokens ? maxTokens : undefined
      } : undefined;
      
      onSelectModel(selectedModel, config);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={agent ? `Select Model for ${agent.name}` : "Select AI Model"}
      size="xl"
      className="max-h-[90vh]"
    >
      <div className="flex flex-col h-[75vh]">
        {/* Sticky Search and Filters */}
        <div className="sticky top-0 z-10 bg-zinc-900 pb-3 mb-3 border-b border-zinc-700">
          <div className="space-y-3">
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models..."
                className="w-full pl-10 pr-10 py-2 text-sm bg-zinc-800 text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-500" />
            
            {uniqueProviders.length > 1 && (
              <select
                value={filterProvider}
                onChange={(e) => setFilterProvider(e.target.value)}
                className="px-2 py-1 text-xs bg-zinc-700 text-white rounded border border-zinc-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
              >
                <option value="all">All Providers</option>
                {uniqueProviders.map(provider => (
                  <option key={provider} value={provider}>
                    {getProviderInfo(provider).name}
                  </option>
                ))}
              </select>
            )}

            {uniqueCostTiers.length > 1 && (
              <select
                value={filterCostTier}
                onChange={(e) => setFilterCostTier(e.target.value)}
                className="px-2 py-1 text-xs bg-zinc-700 text-white rounded border border-zinc-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
              >
                <option value="all">All Costs</option>
                {uniqueCostTiers.map(tier => (
                  <option key={tier} value={tier}>
                    {getCostTierInfo(tier).label || tier}
                  </option>
                ))}
              </select>
            )}

              <span className="ml-auto text-xs text-gray-500">
                {filteredModels.length} models available
              </span>
            </div>
          </div>
        </div>

        {/* Models Grid - Scrollable */}
        <div className="flex-1 overflow-y-auto pr-2" style={{ scrollbarGutter: 'stable' }}>
          {filteredModels.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Object.entries(groupedModels).map(([provider, providerModels]) => (
                <React.Fragment key={provider}>
                  {/* Provider Header */}
                  <div className="col-span-full flex items-center gap-2 mb-2 mt-4 first:mt-0">
                    <span className="text-lg">{getProviderInfo(provider).icon}</span>
                    <span className={`text-sm font-medium ${getProviderInfo(provider).color}`}>
                      {getProviderInfo(provider).name}
                    </span>
                    <div className="flex-1 h-px bg-zinc-800"></div>
                  </div>
                  
                  {/* Provider Models */}
                  {providerModels.map(model => (
                    <div
                      key={model.model_string}
                      onClick={() => setSelectedModel(model)}
                      className={`
                        relative p-4 rounded-lg border cursor-pointer transition-all
                        ${selectedModel?.model_string === model.model_string
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-zinc-700 hover:border-zinc-600 bg-zinc-800/50 hover:bg-zinc-800'
                        }
                      `}
                    >
                      {/* Selected Check */}
                      {selectedModel?.model_string === model.model_string && (
                        <div className="absolute top-3 right-3">
                          <Check className="w-5 h-5 text-purple-400" />
                        </div>
                      )}
                      
                      {/* Model Info */}
                      <div className="pr-8">
                        <h4 className="text-sm font-medium text-white mb-1">
                          {model.display_name}
                        </h4>
                        <p className="text-xs text-gray-500 font-mono mb-2">
                          {model.model}
                        </p>
                        
                        {/* Badges and Pricing on same line */}
                        <div className="flex items-center gap-3 flex-wrap">
                          {model.cost_tier && (
                            <span className={`px-2 py-0.5 text-xs rounded ${getCostTierInfo(model.cost_tier).bgColor} ${getCostTierInfo(model.cost_tier).color}`}>
                              {getCostTierInfo(model.cost_tier).label}
                            </span>
                          )}
                          
                          {/* Detailed Pricing - Input/Output inline */}
                          {model.estimated_cost_per_1k && (
                            <>
                              <span className="text-xs text-gray-500">per 1M:</span>
                              <span className="text-xs font-mono text-emerald-400">
                                in {formatSingleCost(model.estimated_cost_per_1k.input)}
                              </span>
                              <span className="text-xs font-mono text-yellow-400">
                                out {formatSingleCost(model.estimated_cost_per_1k.output)}
                              </span>
                            </>
                          )}
                          
                          {!model.has_api_key && (
                            <span className="px-2 py-0.5 text-xs bg-yellow-500/10 text-yellow-400 rounded flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" />
                              No API Key
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Brain className="w-12 h-12 text-gray-600 mb-3" />
              <p className="text-gray-400 mb-2">No models found</p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  setFilterCostTier('all');
                  setFilterProvider('all');
                }}
                className="text-xs text-purple-400 hover:text-purple-300"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>

        {/* Advanced Settings (if applicable) */}
        {showAdvancedSettings && selectedModel && agent && (agent.supportsTemperature || agent.supportsMaxTokens) && (
          <div className="mt-4 pt-4 border-t border-zinc-700">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              <Settings2 className="w-4 h-4" />
              Advanced Settings
              <ChevronRight className={`w-4 h-4 transition-transform ${showSettings ? 'rotate-90' : ''}`} />
            </button>
            
            {showSettings && (
              <div className="mt-4 space-y-4">
                {agent.supportsTemperature && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">
                      Temperature: <span className="text-white">{temperature}</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={temperature}
                      onChange={(e) => setTemperature(parseFloat(e.target.value))}
                      className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, #7c3aed 0%, #7c3aed ${temperature * 50}%, #27272a ${temperature * 50}%, #27272a 100%)`
                      }}
                    />
                    <div className="flex justify-between text-xs text-gray-600 mt-1">
                      <span>Precise</span>
                      <span>Balanced</span>
                      <span>Creative</span>
                    </div>
                  </div>
                )}
                
                {agent.supportsMaxTokens && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">
                      Max Tokens: <span className="text-white">{maxTokens}</span>
                    </label>
                    <input
                      type="range"
                      min="100"
                      max="4000"
                      step="100"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                      className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, #7c3aed 0%, #7c3aed ${(maxTokens / 4000) * 100}%, #27272a ${(maxTokens / 4000) * 100}%, #27272a 100%)`
                      }}
                    />
                    <div className="flex justify-between text-xs text-gray-600 mt-1">
                      <span>Short</span>
                      <span>Medium</span>
                      <span>Long</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex justify-between items-center mt-6 pt-4 border-t border-zinc-700">
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {uniqueCostTiers.includes('free') && (
              <span className="flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-emerald-400" />
                {filteredModels.filter(m => m.cost_tier === 'free').length} free
              </span>
            )}
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3 text-yellow-400" />
              {uniqueProviders.length} providers
            </span>
          </div>
          
          <div className="flex gap-2">
            <Button
              onClick={onClose}
              variant="ghost"
              size="sm"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSelectModel}
              variant="primary"
              size="sm"
              disabled={!selectedModel || (selectedModel && !selectedModel.has_api_key)}
            >
              {selectedModel && !selectedModel.has_api_key ? 'No API Key' : 'Select Model'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};