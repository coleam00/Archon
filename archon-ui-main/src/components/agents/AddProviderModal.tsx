/**
 * Add Provider Modal Component
 * 
 * Modal for adding new AI providers with API key configuration
 */

import React, { useState, useMemo } from 'react';
import {
  Search,
  X,
  Key,
  ExternalLink,
  Shield,
  Zap,
  Info,
  CheckCircle,
  AlertCircle,
  Globe,
  DollarSign,
  Eye,
  EyeOff,
  Brain,
  FileText
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { useToast } from '../../contexts/ToastContext';
import { cleanProviderService } from '../../services/cleanProviderService';
import type { ProviderMetadata } from '../../types/cleanProvider';

interface AddProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProviderAdded: () => void;
  existingProviders: string[];
  providersMetadata: Record<string, ProviderMetadata>;
}

export const AddProviderModal: React.FC<AddProviderModalProps> = ({
  isOpen,
  onClose,
  onProviderAdded,
  existingProviders,
  providersMetadata
}) => {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  
  const { showToast } = useToast();

  // Provider information
  const providerInfo: Record<string, {
    name: string;
    icon: string;
    color: string;
    description: string;
    apiKeyUrl: string;
    apiKeyPlaceholder: string;
    features: string[];
  }> = {
    openai: {
      name: 'OpenAI',
      icon: '🤖',
      color: 'text-emerald-400',
      description: 'GPT-4, GPT-3.5, and embedding models',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      apiKeyPlaceholder: 'sk-...',
      features: ['GPT-4', 'GPT-3.5 Turbo', 'Embeddings', 'Vision', 'Function Calling']
    },
    anthropic: {
      name: 'Anthropic',
      icon: '🧠',
      color: 'text-blue-400',
      description: 'Claude 3 models with large context windows',
      apiKeyUrl: 'https://console.anthropic.com/settings/keys',
      apiKeyPlaceholder: 'sk-ant-...',
      features: ['Claude 3 Opus', 'Claude 3 Sonnet', 'Claude 3 Haiku', '200K Context', 'Vision']
    },
    google: {
      name: 'Google',
      icon: '🔍',
      color: 'text-yellow-400',
      description: 'Gemini models with multimodal capabilities',
      apiKeyUrl: 'https://makersuite.google.com/app/apikey',
      apiKeyPlaceholder: 'AIza...',
      features: ['Gemini Pro', 'Gemini Pro Vision', 'Embeddings', 'Long Context']
    },
    mistral: {
      name: 'Mistral',
      icon: '🌊',
      color: 'text-purple-400',
      description: 'Open-weight models with strong performance',
      apiKeyUrl: 'https://console.mistral.ai/api-keys',
      apiKeyPlaceholder: 'API key',
      features: ['Mistral Large', 'Mistral Medium', 'Mistral Small', 'Embeddings']
    },
    groq: {
      name: 'Groq',
      icon: '⚡',
      color: 'text-orange-400',
      description: 'Ultra-fast inference with LPU technology',
      apiKeyUrl: 'https://console.groq.com/keys',
      apiKeyPlaceholder: 'gsk_...',
      features: ['Llama 3', 'Mixtral', 'Gemma', 'Ultra Fast', 'Free Tier']
    },
    deepseek: {
      name: 'DeepSeek',
      icon: '🔬',
      color: 'text-cyan-400',
      description: 'Cost-effective models with coding capabilities',
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
      apiKeyPlaceholder: 'sk-...',
      features: ['DeepSeek Coder', 'DeepSeek Chat', 'Low Cost', 'Code Generation']
    },
    cohere: {
      name: 'Cohere',
      icon: '🌐',
      color: 'text-indigo-400',
      description: 'Enterprise-focused language models',
      apiKeyUrl: 'https://dashboard.cohere.com/api-keys',
      apiKeyPlaceholder: 'API key',
      features: ['Command R+', 'Command R', 'Embeddings', 'Rerank', 'RAG Optimized']
    },
    xai: {
      name: 'xAI',
      icon: '✖️',
      color: 'text-red-400',
      description: 'Grok models with real-time knowledge',
      apiKeyUrl: 'https://x.ai/api',
      apiKeyPlaceholder: 'xai-...',
      features: ['Grok-1', 'Real-time Data', 'Large Context']
    },
    openrouter: {
      name: 'OpenRouter',
      icon: '🌍',
      color: 'text-pink-400',
      description: 'Unified API for multiple model providers',
      apiKeyUrl: 'https://openrouter.ai/keys',
      apiKeyPlaceholder: 'sk-or-...',
      features: ['100+ Models', 'Unified API', 'Fallback Support', 'Usage Analytics']
    },
    ollama: {
      name: 'Ollama',
      icon: '🦙',
      color: 'text-gray-400',
      description: 'Run open-source models locally',
      apiKeyUrl: '',
      apiKeyPlaceholder: 'http://localhost:11434',
      features: ['Local Models', 'Privacy', 'No API Key', 'Offline', 'Custom Models']
    }
  };

  // Filter available providers based on backend metadata
  const filteredProviders = useMemo(() => {
    // Get all providers from metadata
    const allProviderKeys = Object.keys(providersMetadata);

    if (!searchQuery) return allProviderKeys;

    const query = searchQuery.toLowerCase();
    return allProviderKeys.filter(key => {
      const info = providerInfo[key];
      const metadata = providersMetadata[key];
      
      // Search in provider name, description, and features
      return (
        key.toLowerCase().includes(query) ||
        (info && (
          info.name.toLowerCase().includes(query) ||
          info.description.toLowerCase().includes(query) ||
          info.features.some(f => f.toLowerCase().includes(query))
        )) ||
        (metadata && metadata.provider.toLowerCase().includes(query))
      );
    });
  }, [searchQuery, providersMetadata]);

  // Get metadata for selected provider
  const selectedProviderMeta = useMemo(() => {
    if (!selectedProvider) return null;
    return providersMetadata[selectedProvider];
  }, [selectedProvider, providersMetadata]);

  // Handle provider selection
  const handleSelectProvider = (provider: string) => {
    setSelectedProvider(provider);
    setApiKey('');
  };

  // Handle adding or updating provider
  const handleAddProvider = async () => {
    if (!selectedProvider || !apiKey.trim()) {
      showToast('Please select a provider and enter an API key', 'error');
      return;
    }

    try {
      setIsAdding(true);
      
      // Add or update the API key
      await cleanProviderService.setApiKey(selectedProvider, apiKey.trim());
      
      const isUpdate = existingProviders.includes(selectedProvider);
      showToast(
        `${providerInfo[selectedProvider].name} ${isUpdate ? 'updated' : 'added'} successfully`, 
        'success'
      );
      onProviderAdded();
      
      // Reset form
      setSelectedProvider(null);
      setApiKey('');
      setSearchQuery('');
      onClose();
    } catch (error) {
      console.error('Failed to add/update provider:', error);
      showToast('Failed to add/update provider', 'error');
    } finally {
      setIsAdding(false);
    }
  };

  // Reset state when modal opens/closes
  React.useEffect(() => {
    if (!isOpen) {
      setSelectedProvider(null);
      setApiKey('');
      setSearchQuery('');
      setShowApiKey(false);
    }
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add AI Provider"
      size="lg"
    >
      <div className="space-y-6">
        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search providers..."
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

        {/* Provider Selection */}
        {!selectedProvider ? (
          <div>
            {/* Show info if some providers are already configured */}
            {existingProviders.length > 0 && (
              <div className="mb-3 p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <p className="text-xs text-blue-400">
                  <Info className="w-3 h-3 inline mr-1" />
                  Configured providers are shown but disabled. Manage them in the main provider list.
                </p>
              </div>
            )}
            
            <div className="space-y-3 max-h-96 overflow-y-auto">
            {filteredProviders.length > 0 ? (
              filteredProviders.map(key => {
                const info = providerInfo[key];  // UI display info (icons, colors, etc)
                const metadata = providersMetadata[key];  // Backend metadata (models, costs, etc)
                const isConfigured = existingProviders.includes(key);
                
                return (
                  <div
                    key={key}
                    className={`w-full p-4 rounded-lg border transition-all text-left ${
                      isConfigured 
                        ? 'border-emerald-900/50 bg-emerald-950/20'
                        : 'border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl">{info?.icon || '🤖'}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className={`font-medium ${info?.color || 'text-gray-400'}`}>
                            {info?.name || key.charAt(0).toUpperCase() + key.slice(1)}
                          </h3>
                          {isConfigured && (
                            <Badge variant="success" className="text-xs">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              Configured
                            </Badge>
                          )}
                          {!isConfigured && metadata && (
                            <Badge variant="secondary" className="text-xs">
                              {metadata.model_count} models
                            </Badge>
                          )}
                        </div>
                        
                        {/* Use backend metadata for description */}
                        <p className="text-xs text-gray-400 mb-2">
                          {info?.description || 
                           (metadata && `${metadata.model_count} models available${metadata.has_free_models ? ' • Free tier available' : ''}`)}
                        </p>
                        
                        {/* Show backend metadata features */}
                        {!isConfigured && metadata && (
                          <div className="space-y-2">
                            {/* Feature badges */}
                            <div className="flex flex-wrap gap-1">
                              {metadata.has_free_models && (
                                <span className="px-2 py-0.5 text-xs bg-emerald-900/30 text-emerald-400 rounded">
                                  Free Models
                                </span>
                              )}
                              {metadata.supports_vision && (
                                <span className="px-2 py-0.5 text-xs bg-blue-900/30 text-blue-400 rounded">
                                  Vision
                                </span>
                              )}
                              {metadata.supports_tools && (
                                <span className="px-2 py-0.5 text-xs bg-purple-900/30 text-purple-400 rounded">
                                  Tools/Functions
                                </span>
                              )}
                              {metadata.max_context_length > 100000 && (
                                <span className="px-2 py-0.5 text-xs bg-yellow-900/30 text-yellow-400 rounded">
                                  {Math.floor(metadata.max_context_length / 1000)}K Context
                                </span>
                              )}
                            </div>
                            
                            {/* Cost range */}
                            {metadata.min_input_cost > 0 && (
                              <div className="text-xs text-gray-500">
                                <DollarSign className="w-3 h-3 inline mr-1" />
                                ${metadata.min_input_cost.toFixed(4)} - ${metadata.max_input_cost.toFixed(2)}/1M tokens
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      {!isConfigured && (
                        <button
                          onClick={() => handleSelectProvider(key)}
                          className="px-3 py-1 text-xs bg-purple-600/20 text-purple-400 rounded hover:bg-purple-600/30 transition-colors"
                        >
                          Configure
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="text-center py-8">
                <AlertCircle className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400">
                  No providers found matching your search
                </p>
              </div>
            )}
            </div>
          </div>
        ) : (
          // API Key Configuration
          <div className="space-y-4">
            {/* Selected Provider Header */}
            <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{providerInfo[selectedProvider]?.icon || '🤖'}</span>
                <div>
                  <h3 className={`font-medium ${providerInfo[selectedProvider]?.color || 'text-gray-400'}`}>
                    {providerInfo[selectedProvider]?.name || selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1)}
                  </h3>
                  {selectedProviderMeta && (
                    <div className="space-y-1">
                      <p className="text-xs text-gray-400">
                        {selectedProviderMeta.model_count} models available
                      </p>
                      <div className="flex items-center gap-2 text-xs">
                        {selectedProviderMeta.has_free_models && (
                          <span className="text-emerald-400">Free tier</span>
                        )}
                        {selectedProviderMeta.max_context_length > 0 && (
                          <span className="text-blue-400">
                            Max {Math.floor(selectedProviderMeta.max_context_length / 1000)}K context
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => setSelectedProvider(null)}
                className="text-gray-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* API Key Input */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                API Key
              </label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={providerInfo[selectedProvider].apiKeyPlaceholder}
                  className="w-full pl-10 pr-10 py-2 text-sm bg-zinc-800 text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                >
                  {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              
              {providerInfo[selectedProvider].apiKeyUrl && (
                <a
                  href={providerInfo[selectedProvider].apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mt-2 text-xs text-purple-400 hover:text-purple-300"
                >
                  Get API key
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            {/* Info Box */}
            <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <div className="flex gap-2">
                <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-gray-300 space-y-1">
                  <p>Your API key will be stored securely and never exposed in the UI.</p>
                  {selectedProvider === 'ollama' && (
                    <p>For Ollama, enter the base URL of your Ollama server (e.g., http://localhost:11434).</p>
                  )}
                </div>
              </div>
            </div>

            {/* Features from Backend Metadata */}
            {selectedProviderMeta && (
              <div>
                <h4 className="text-xs font-medium text-gray-400 mb-2">Provider Details</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-zinc-900/50 rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <Brain className="w-4 h-4 text-purple-400" />
                      <span className="text-xs text-gray-400">Models</span>
                    </div>
                    <p className="text-sm text-white font-medium">
                      {selectedProviderMeta.model_count}
                    </p>
                  </div>
                  
                  <div className="p-3 bg-zinc-900/50 rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className="w-4 h-4 text-blue-400" />
                      <span className="text-xs text-gray-400">Max Context</span>
                    </div>
                    <p className="text-sm text-white font-medium">
                      {Math.floor(selectedProviderMeta.max_context_length / 1000)}K
                    </p>
                  </div>
                  
                  {selectedProviderMeta.min_input_cost > 0 && (
                    <div className="p-3 bg-zinc-900/50 rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <DollarSign className="w-4 h-4 text-green-400" />
                        <span className="text-xs text-gray-400">Cost Range</span>
                      </div>
                      <p className="text-sm text-white font-medium">
                        ${selectedProviderMeta.min_input_cost.toFixed(3)} - ${selectedProviderMeta.max_input_cost.toFixed(2)}
                      </p>
                      <p className="text-xs text-gray-500">per 1M tokens</p>
                    </div>
                  )}
                  
                  <div className="p-3 bg-zinc-900/50 rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <Zap className="w-4 h-4 text-yellow-400" />
                      <span className="text-xs text-gray-400">Capabilities</span>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {selectedProviderMeta.has_free_models && (
                        <span className="px-1.5 py-0.5 text-xs bg-emerald-900/30 text-emerald-400 rounded">
                          Free
                        </span>
                      )}
                      {selectedProviderMeta.supports_vision && (
                        <span className="px-1.5 py-0.5 text-xs bg-blue-900/30 text-blue-400 rounded">
                          Vision
                        </span>
                      )}
                      {selectedProviderMeta.supports_tools && (
                        <span className="px-1.5 py-0.5 text-xs bg-purple-900/30 text-purple-400 rounded">
                          Tools
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                
                {/* Top Models if available */}
                {selectedProviderMeta.top_models && selectedProviderMeta.top_models.length > 0 && (
                  <div className="mt-3">
                    <h5 className="text-xs font-medium text-gray-400 mb-2">Popular Models</h5>
                    <div className="space-y-1">
                      {selectedProviderMeta.top_models.slice(0, 3).map((model, idx) => (
                        <div key={idx} className="flex items-center justify-between text-xs">
                          <span className="text-gray-300">{model.model}</span>
                          <span className="text-gray-500">
                            ${model.input_cost.toFixed(4)}/1K
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-zinc-700">
          <Button
            onClick={onClose}
            variant="ghost"
            size="sm"
          >
            Cancel
          </Button>
          {selectedProvider && (
            <Button
              onClick={handleAddProvider}
              variant="primary"
              size="sm"
              disabled={!apiKey.trim() || isAdding}
            >
              {isAdding ? 'Saving...' : 
               existingProviders.includes(selectedProvider || '') ? 'Update Provider' : 'Add Provider'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};