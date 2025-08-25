/**
 * Provider Settings Component
 * 
 * Manages API keys for the clean provider system
 * Shows only active providers with option to add more
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Key,
  Check,
  X,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  TestTube,
  Plus,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  Save,
  RefreshCw,
  Search,
  Sparkles,
  ChevronDown,
  ImageIcon,
  Wrench
} from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { cleanProviderService } from '../../services/cleanProviderService';
import type { ProviderType, ProviderStatus, ProviderMetadata } from '../../types/cleanProvider';
import { Button } from '../ui/Button';
import { AddProviderModal } from '../agents/AddProviderModal';

interface ProviderCardProps {
  provider: ProviderStatus;
  metadata?: any;
  onSave: (provider: ProviderType, apiKey: string, baseUrl?: string) => Promise<void>;
  onTest: (provider: ProviderType) => Promise<void>;
  onRemove: (provider: ProviderType) => Promise<void>;
}

const ProviderCard: React.FC<ProviderCardProps> = ({ provider, metadata, onSave, onTest, onRemove }) => {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showInput, setShowInput] = useState(!provider.configured);

  const getProviderDisplayName = (provider: ProviderType): string => {
    const names: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      google: 'Google AI',
      gemini: 'Google Gemini',
      groq: 'Groq',
      mistral: 'Mistral AI',
      mistralai: 'Mistral AI',
      ollama: 'Ollama (Local)',
      cohere: 'Cohere',
      meta: 'Meta',
      'meta-llama': 'Meta Llama',
      deepseek: 'DeepSeek',
      qwen: 'Qwen',
      ai21: 'AI21 Labs',
      xai: 'xAI',
      'x-ai': 'xAI',
      nvidia: 'NVIDIA',
      microsoft: 'Microsoft',
      alibaba: 'Alibaba',
      baidu: 'Baidu',
      openrouter: 'OpenRouter',
      perplexity: 'Perplexity',
      together: 'Together AI',
      fireworks: 'Fireworks AI',
      replicate: 'Replicate',
      databricks: 'Databricks',
      inflection: 'Inflection',
      '01-ai': '01.AI',
      '01ai': '01.AI',
      nousresearch: 'NousResearch',
      nous: 'NousResearch'
    };
    // Capitalize first letter if not in mapping
    const displayName = names[provider.toLowerCase()];
    if (displayName) return displayName;
    
    // Handle special cases like "z-ai" -> "Z.AI"
    if (provider.includes('-')) {
      return provider.split('-').map(part => 
        part.toUpperCase()
      ).join('.');
    }
    
    // Default: capitalize first letter
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  };

  const getProviderIcon = (provider: ProviderType): string => {
    const icons: Record<string, string> = {
      openai: '🤖',
      anthropic: '🧠',
      google: '🔍',
      gemini: '✨',
      groq: '⚡',
      mistral: '🌊',
      mistralai: '🌊',
      ollama: '🦙',
      cohere: '🌐',
      meta: '🔷',
      'meta-llama': '🦙',
      deepseek: '🔬',
      qwen: '🏮',
      ai21: '🚀',
      xai: '✖️',
      'x-ai': '✖️',
      nvidia: '💚',
      microsoft: '🪟',
      alibaba: '🏪',
      baidu: '🔴',
      perplexity: '🔎',
      together: '🤝',
      fireworks: '🎆',
      replicate: '🔁',
      databricks: '📊',
      inflection: '💬',
      '01-ai': '0️⃣',
      '01ai': '0️⃣',
      nousresearch: '🔬',
      nous: '🔬',
      'z-ai': '⚡',
      zai: '⚡',
      openrouter: '🌍'
    };
    return icons[provider.toLowerCase()] || '🤖';
  };

  const getProviderDocs = (provider: ProviderType): string => {
    const docs: Record<string, string> = {
      openai: 'https://platform.openai.com/api-keys',
      anthropic: 'https://console.anthropic.com/account/keys',
      google: 'https://makersuite.google.com/app/apikey',
      gemini: 'https://makersuite.google.com/app/apikey',
      groq: 'https://console.groq.com/keys',
      mistral: 'https://console.mistral.ai/api-keys',
      mistralai: 'https://console.mistral.ai/api-keys',
      ollama: 'https://ollama.ai/docs',
      cohere: 'https://dashboard.cohere.com/api-keys',
      meta: 'https://ai.meta.com/llama/',
      'meta-llama': 'https://ai.meta.com/llama/',
      deepseek: 'https://platform.deepseek.com/api_keys',
      qwen: 'https://dashscope.console.aliyun.com/',
      ai21: 'https://studio.ai21.com/account/api-keys',
      openrouter: 'https://openrouter.ai/keys',
      xai: 'https://x.ai/api',
      'x-ai': 'https://x.ai/api',
      perplexity: 'https://www.perplexity.ai/settings/api',
      together: 'https://api.together.xyz/settings/api-keys',
      fireworks: 'https://app.fireworks.ai/api-keys',
      replicate: 'https://replicate.com/account/api-tokens',
      databricks: 'https://docs.databricks.com/dev-tools/auth.html'
    };
    return docs[provider.toLowerCase()] || '#';
  };

  const getStatusIcon = (health: ProviderStatus['health']) => {
    switch (health) {
      case 'healthy':
        return <CheckCircle className="w-3 h-3 text-emerald-400" />;
      case 'degraded':
        return <Clock className="w-3 h-3 text-yellow-500" />;
      case 'error':
        return <XCircle className="w-3 h-3 text-red-500" />;
      default:
        return <AlertCircle className="w-3 h-3 text-gray-500" />;
    }
  };

  const handleSave = async () => {
    if (!apiKey && provider.provider !== 'ollama') {
      return;
    }

    setSaving(true);
    try {
      await onSave(provider.provider, apiKey, baseUrl || undefined);
      setShowInput(false);
      setApiKey('');
      setBaseUrl('');
    } catch (error) {
      // Error handled in parent
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await onTest(provider.provider);
    } finally {
      setTesting(false);
    }
  };

  const handleRemove = async () => {
    try {
      await onRemove(provider.provider);
      setShowInput(true);
    } catch (error) {
      // Error handled in parent
    }
  };

  const isConfigured = provider.configured;

  return (
    <div 
      className={`relative rounded-xl transition-all duration-300 hover:scale-[1.005] overflow-hidden ${
        isConfigured ? 'hover:shadow-lg' : ''
      }`}
      style={{
        background: isConfigured 
          ? 'linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)'
          : 'linear-gradient(135deg, rgba(15, 18, 30, 0.7) 0%, rgba(10, 12, 20, 0.8) 100%)',
        backdropFilter: 'blur(10px)'
      }}
    >
      {/* Animated status bar for configured providers */}
      {isConfigured && provider.health === 'healthy' && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500 animate-pulse" />
      )}
      
      {/* Border gradient */}
      <div className="absolute inset-0 rounded-xl p-[1px] pointer-events-none" style={{
        background: isConfigured 
          ? 'linear-gradient(180deg, rgba(168, 85, 247, 0.3) 0%, rgba(59, 130, 246, 0.2) 100%)'
          : 'linear-gradient(180deg, rgba(100, 100, 100, 0.1) 0%, rgba(50, 50, 50, 0.05) 100%)'
      }}>
        <div className="w-full h-full rounded-xl" style={{
          background: isConfigured 
            ? 'linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)'
            : 'linear-gradient(135deg, rgba(15, 18, 30, 0.7) 0%, rgba(10, 12, 20, 0.8) 100%)'
        }} />
      </div>

      <div className="relative p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-start gap-3">
            <div className="text-2xl mt-1">{getProviderIcon(provider.provider)}</div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-light text-white">
                  {getProviderDisplayName(provider.provider)}
                </h4>
                {provider.configured && (
                  <span className="px-2 py-0.5 text-xs rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Active
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5">
                {getStatusIcon(provider.health)}
                {provider.health === 'healthy' ? 'Connected' : 
                 provider.health === 'degraded' ? 'Issues detected' :
                 provider.health === 'error' ? 'Connection failed' :
                 'Not configured'}
              </p>
              {metadata && (
                <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                  {metadata.model_count > 0 && (
                    <span title="Available models">
                      {metadata.model_count} models
                    </span>
                  )}
                  {metadata.max_context_length > 0 && (
                    <span title="Maximum context length">
                      {metadata.max_context_length >= 1000000 
                        ? `${Math.floor(metadata.max_context_length / 1000000)}M` 
                        : metadata.max_context_length >= 1000 
                        ? `${Math.floor(metadata.max_context_length / 1000)}K` 
                        : metadata.max_context_length} tokens
                    </span>
                  )}
                  {metadata.has_free_models && (
                    <span className="text-emerald-400" title="Has free models">
                      Free tier
                    </span>
                  )}
                  {metadata.min_input_cost > 0 && (
                    <span title="Cost range per 1M input tokens">
                      ${metadata.min_input_cost < 1 
                        ? metadata.min_input_cost.toFixed(3)
                        : metadata.min_input_cost.toFixed(2)}{metadata.max_input_cost !== metadata.min_input_cost 
                        ? `-$${metadata.max_input_cost < 1 
                          ? metadata.max_input_cost.toFixed(3) 
                          : metadata.max_input_cost.toFixed(2)}`
                        : ''}/1M
                    </span>
                  )}
                  {metadata.supports_vision && (
                    <ImageIcon className="w-3 h-3 text-blue-400" title="Supports vision/image input" />
                  )}
                  {metadata.supports_tools && (
                    <Wrench className="w-3 h-3 text-purple-400" title="Supports function calling/tools" />
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {provider.configured && (
              <>
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
                  title="Test connection"
                >
                  {testing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <TestTube className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={handleRemove}
                  className="p-1.5 text-gray-400 hover:text-red-400 rounded-lg hover:bg-red-500/5 transition-colors"
                  title="Remove API key"
                >
                  <X className="w-4 h-4" />
                </button>
              </>
            )}
            
            {!showInput && !provider.configured && (
              <button
                onClick={() => setShowInput(true)}
                className="px-3 py-1.5 bg-purple-600/20 text-purple-400 text-xs rounded-lg hover:bg-purple-600/30 transition-colors flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                <span>Configure</span>
              </button>
            )}

            {getProviderDocs(provider.provider) !== '#' && (
              <a
                href={getProviderDocs(provider.provider)}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
                title="Get API key"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>

        {showInput && (
          <div className="space-y-3 pt-2 border-t border-zinc-800/50">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                API Key {provider.provider === 'ollama' && '(Optional)'}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={provider.provider === 'ollama' ? 'Not required for local' : 'sk-...'}
                    className="w-full px-3 py-1.5 pr-10 text-xs border border-zinc-700/50 rounded-lg bg-zinc-900/50 text-white focus:ring-1 focus:ring-purple-500 focus:border-purple-500 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300"
                  >
                    {showKey ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <Button
                  onClick={handleSave}
                  disabled={(!apiKey && provider.provider !== 'ollama') || saving}
                  className="bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 text-white text-xs px-3 py-1.5"
                >
                  {saving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  <span className="ml-1">{provider.configured ? 'Update' : 'Save'}</span>
                </Button>
              </div>
            </div>

            {provider.provider === 'ollama' && (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">
                  Base URL (Optional)
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  className="w-full px-3 py-1.5 text-xs border border-zinc-700/50 rounded-lg bg-zinc-900/50 text-white focus:ring-1 focus:ring-purple-500 focus:border-purple-500 transition-all"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};


interface ProviderSettingsProps {
  onProviderAdded?: () => void;
}

export const ProviderSettings: React.FC<ProviderSettingsProps> = React.memo(({ onProviderAdded }) => {
  const [allProviders, setAllProviders] = useState<string[]>([]);
  const [activeProviders, setActiveProviders] = useState<ProviderStatus[]>([]);
  const [providersMetadata, setProvidersMetadata] = useState<Record<string, ProviderMetadata>>({});
  const [loading, setLoading] = useState(true);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const { showToast } = useToast();

  // Load provider status on mount
  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      setLoading(true);
      
      // Get all available providers, current status, and metadata
      const [allProviderList, providerStatuses, metadata] = await Promise.all([
        cleanProviderService.getAllProviders(),
        cleanProviderService.getAllProviderStatuses(),
        cleanProviderService.getProvidersMetadata()
      ]);

      // Filter to only show configured providers
      const configuredProviders = providerStatuses.filter(p => p.configured);
      setActiveProviders(configuredProviders);
      setProvidersMetadata(metadata);
      
      // Get list of unconfigured providers
      const configuredNames = configuredProviders.map(p => p.provider);
      const unconfiguredProviders = allProviderList.filter(p => !configuredNames.includes(p));
      setAllProviders(unconfiguredProviders);
      
    } catch (error) {
      console.error('Failed to load providers:', error);
      showToast('Failed to load provider information', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAddProvider = (provider: ProviderType) => {
    // Add provider to active list
    const newProvider: ProviderStatus = {
      provider,
      health: 'not_configured',
      configured: false,
      lastChecked: new Date().toISOString()
    };
    
    setActiveProviders([...activeProviders, newProvider]);
    setAllProviders(allProviders.filter(p => p !== provider));
  };

  const handleSaveApiKey = async (provider: ProviderType, apiKey: string, baseUrl?: string) => {
    try {
      await cleanProviderService.setApiKey(provider, apiKey, baseUrl);
      showToast(`${provider} API key saved successfully`, 'success');
      await loadProviders();
    } catch (error) {
      console.error('Failed to save API key:', error);
      showToast('Failed to save API key', 'error');
      throw error;
    }
  };

  const handleTestConnection = async (provider: ProviderType) => {
    try {
      const result = await cleanProviderService.testApiKey(provider);
      
      if (result.configured && result.status === 'active') {
        showToast(`${provider} connection successful`, 'success');
      } else {
        showToast(`${provider} connection failed`, 'error');
      }
      
      await loadProviders();
    } catch (error) {
      console.error('Failed to test connection:', error);
      showToast('Connection test failed', 'error');
    }
  };

  const handleRemoveApiKey = async (provider: ProviderType) => {
    try {
      await cleanProviderService.deactivateApiKey(provider);
      showToast(`${provider} API key removed`, 'success');
      await loadProviders();
    } catch (error) {
      console.error('Failed to remove API key:', error);
      showToast('Failed to remove API key', 'error');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-light text-white">Provider Configuration</h3>
          <p className="text-sm text-gray-400 mt-1">
            {activeProviders.length === 0 
              ? 'No providers configured yet' 
              : `${activeProviders.length} active provider${activeProviders.length === 1 ? '' : 's'}`}
          </p>
        </div>
        
        <Button
          onClick={() => setIsAddModalOpen(true)}
          variant="primary"
          size="sm"
          className="flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Provider
        </Button>
      </div>

      {/* Active Providers */}
      {activeProviders.length > 0 ? (
        <div className="grid gap-3">
          {activeProviders.map((provider) => (
            <ProviderCard
              key={provider.provider}
              provider={provider}
              metadata={providersMetadata[provider.provider]}
              onSave={handleSaveApiKey}
              onTest={handleTestConnection}
              onRemove={handleRemoveApiKey}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 rounded-xl border border-zinc-800/50 bg-zinc-900/20">
          <Key className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 text-sm mb-4">
            No providers configured yet
          </p>
          <p className="text-gray-500 text-xs mb-6 max-w-md mx-auto">
            Add a provider to start using AI models. You can configure multiple providers
            and switch between them based on your needs.
          </p>
        </div>
      )}

      {/* Security Info Box */}
      {activeProviders.length > 0 && (
        <div className="relative rounded-xl p-4 mt-6"
             style={{
               background: 'linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)',
               backdropFilter: 'blur(10px)'
             }}>
          <div className="absolute inset-0 rounded-xl p-[1px] pointer-events-none" style={{
            background: 'linear-gradient(180deg, rgba(59, 130, 246, 0.2) 0%, rgba(59, 130, 246, 0.05) 100%)'
          }}>
            <div className="w-full h-full rounded-xl" style={{
              background: 'linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)'
            }} />
          </div>
          
          <div className="relative flex gap-3">
            <Shield className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-gray-400">
              <p className="font-medium text-blue-400 mb-1">Secure Storage</p>
              <p className="leading-relaxed">
                API keys are encrypted with Fernet encryption and stored securely in your database. 
                They are never exposed in the frontend and only used server-side for AI model requests.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Add Provider Modal */}
      <AddProviderModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onProviderAdded={async () => {
          await loadProviders();
          // Also notify parent component if callback provided
          if (onProviderAdded) {
            onProviderAdded();
          }
        }}
        existingProviders={activeProviders.map(p => p.provider)}
        providersMetadata={providersMetadata}
      />
    </div>
  );
});