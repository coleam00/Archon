import React, { useEffect, useState } from 'react';
import { Cpu, AlertCircle, CheckCircle, RefreshCw, Coins, Hash } from 'lucide-react';
import { cleanProviderService } from '../services/cleanProviderService';
import { AGENT_CONFIGS } from '../types/agent';

interface ActiveModel {
  model_string: string;
  provider: string;
  model: string;
  api_key_configured: boolean;
  is_default?: boolean;
}

interface ModelStatus {
  active_models: Record<string, ActiveModel>;
  api_key_status: Record<string, boolean>;
  usage?: {
    total_tokens_today: number;
    total_cost_today: number;
    estimated_monthly_cost: number;
  };
  timestamp: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  'openai': 'bg-green-500',
  'anthropic': 'bg-orange-500',
  'google': 'bg-blue-500',
  'mistral': 'bg-purple-500',
  'groq': 'bg-pink-500',
  'deepseek': 'bg-indigo-500',
  'ollama': 'bg-gray-500',
  'openrouter': 'bg-teal-500',
  'unknown': 'bg-gray-400'
};

// Helper function to format large numbers
const formatTokens = (num: number): string => {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
};

// Helper function to format currency
const formatCurrency = (amount: number): string => {
  if (amount < 0.01) {
    return '$0.00';
  } else if (amount < 1) {
    return `$${amount.toFixed(3)}`;
  } else if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(1)}K`;
  }
  return `$${amount.toFixed(2)}`;
};

export const ModelStatusBar: React.FC = () => {
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchModelStatus = async () => {
    try {
      setError(null);
      console.log('ModelStatusBar: Fetching model status...');
      const status = await cleanProviderService.getActiveModels();
      console.log('ModelStatusBar: Status received:', status);
      setModelStatus(status);
    } catch (err) {
      console.error('ModelStatusBar: Failed to fetch model status:', err);
      setError('Failed to fetch model status');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    console.log('ModelStatusBar: Component mounted');
    fetchModelStatus();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchModelStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchModelStatus();
  };

  // Always show a bar, even while loading
  if (loading) {
    return (
      <div className="bg-gray-900/95 backdrop-blur-sm border-b border-gray-700 px-4 py-1.5 shadow-lg">
        <div className="flex items-center gap-2 text-gray-400">
          <Cpu className="w-3 h-3 animate-pulse" />
          <span className="text-xs">Loading model status...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border-b border-red-800 px-4 py-1.5">
        <div className="flex items-center gap-2 text-red-400">
          <AlertCircle className="w-3 h-3" />
          <span className="text-xs">{error}</span>
        </div>
      </div>
    );
  }

  if (!modelStatus) {
    return null;
  }

  return (
    <div className="bg-gray-900/95 backdrop-blur-sm border-b border-gray-700 px-4 py-1.5 shadow-lg" id="model-status-bar">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Usage Statistics */}
          {modelStatus.usage && (
            <>
              <div className="flex items-center gap-1.5 text-xs">
                <Hash className="w-3 h-3 text-cyan-400" />
                <span className="text-gray-400">Tokens:</span>
                <span className="font-mono text-cyan-300">
                  {formatTokens(modelStatus.usage.total_tokens_today)}
                </span>
              </div>
              
              <div className="flex items-center gap-1.5 text-xs">
                <Coins className="w-3 h-3 text-yellow-400" />
                <span className="text-gray-400">Today:</span>
                <span className="font-mono text-yellow-300">
                  {formatCurrency(modelStatus.usage.total_cost_today)}
                </span>
              </div>
              
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-500">Month est:</span>
                <span className="font-mono text-gray-400">
                  {formatCurrency(modelStatus.usage.estimated_monthly_cost)}
                </span>
              </div>
              
              <div className="w-px h-4 bg-gray-700" />
            </>
          )}
          
          {/* Models */}
          <div className="flex items-center gap-2">
            <Cpu className="w-3 h-3 text-blue-400" />
            <span className="text-xs font-medium text-gray-300">Models:</span>
          </div>
          
          {Object.entries(modelStatus.active_models)
            .filter(([service]) => {
              // Only show services that are defined in our agent registry
              return AGENT_CONFIGS[service] !== undefined;
            })
            .map(([service, model]) => (
            <div
              key={service}
              className="flex items-center gap-1 bg-gray-800/50 rounded px-1.5 py-0.5"
              title={`${AGENT_CONFIGS[service]?.name || service}: ${model.model_string}`}
            >
              <span className="text-[10px] text-gray-400">
                {AGENT_CONFIGS[service]?.name || service}:
              </span>
              <div className="flex items-center gap-1">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${
                    PROVIDER_COLORS[model.provider] || PROVIDER_COLORS.unknown
                  }`}
                  title={model.provider}
                />
                <span className="text-[10px] font-mono text-gray-300">
                  {model.model.length > 15 
                    ? `${model.model.substring(0, 15)}...` 
                    : model.model}
                </span>
                {!model.api_key_configured && (
                  <AlertCircle className="w-2.5 h-2.5 text-yellow-500" title="API key not configured" />
                )}
                {model.is_default && (
                  <span className="text-[9px] text-gray-600">(def)</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="p-1.5 rounded hover:bg-gray-800 transition-colors"
          title="Refresh model status"
        >
          <RefreshCw 
            className={`w-4 h-4 text-gray-400 ${isRefreshing ? 'animate-spin' : ''}`} 
          />
        </button>
      </div>

    </div>
  );
};