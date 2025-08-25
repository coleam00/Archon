/**
 * Agent Card Component
 * 
 * Displays an agent/service with model configuration options
 * Styled to match the existing EnhancedProviderCard UI patterns
 */

import React, { useState, useEffect } from 'react';
import { 
  Settings2, 
  AlertCircle, 
  Check,
  ChevronDown,
  Zap,
  DollarSign,
  Activity,
  Clock,
  CheckCircle,
  XCircle,
  MoreVertical,
  Sliders,
  Edit3
} from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { cleanProviderService } from '../../services/cleanProviderService';
import type { AgentConfig } from '../../types/agent';
import type { AvailableModel } from '../../types/cleanProvider';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { ModelSelectionModal } from './ModelSelectionModal';

interface AgentCardProps {
  agent: AgentConfig;
  availableModels: AvailableModel[];
  currentConfig?: {
    model_string: string;
    temperature?: number;
    max_tokens?: number;
  };
  onConfigUpdate: (agentId: string, config: any) => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  availableModels,
  currentConfig,
  onConfigUpdate
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(currentConfig?.model_string || agent.defaultModel);
  const [temperature, setTemperature] = useState(currentConfig?.temperature || 0.7);
  const [maxTokens, setMaxTokens] = useState(currentConfig?.max_tokens || 2000);
  const [isSaving, setIsSaving] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'healthy' | 'unhealthy' | 'checking' | null>(null);
  
  const { showToast } = useToast();

  // Filter models based on type (LLM vs embedding)
  const compatibleModels = availableModels.filter(m => {
    if (agent.modelType === 'embedding') {
      return m.model_string.includes('embedding');
    }
    return !m.model_string.includes('embedding');
  });

  const handleModelSelect = async (model: AvailableModel, config?: { temperature?: number; maxTokens?: number }) => {
    // Close modal immediately for better UX
    setIsModalOpen(false);
    
    // Optimistically update the UI
    const newConfig: any = {
      service_name: agent.id,
      model_string: model.model_string
    };
    
    if (config?.temperature !== undefined) {
      newConfig.temperature = config.temperature;
      setTemperature(config.temperature);
    }
    
    if (config?.maxTokens !== undefined) {
      newConfig.max_tokens = config.maxTokens;
      setMaxTokens(config.maxTokens);
    }
    
    // Update local state immediately
    setSelectedModel(model.model_string);
    onConfigUpdate(agent.id, newConfig);
    
    // Show saving status
    setIsSaving(true);
    setHealthStatus('checking');
    
    try {
      // Save to backend asynchronously
      await cleanProviderService.updateModelConfig(
        agent.id,
        model.model_string,
        newConfig
      );
      
      setHealthStatus('healthy');
      showToast(`${agent.name} configuration updated`, 'success');
      setTimeout(() => {
        setHealthStatus(null);
      }, 1500);
    } catch (error) {
      console.error('Failed to save agent config:', error);
      setHealthStatus('unhealthy');
      showToast('Failed to save configuration', 'error');
      
      // Revert the optimistic update on error
      setSelectedModel(currentConfig?.model_string || agent.defaultModel);
      setTemperature(currentConfig?.temperature || 0.7);
      setMaxTokens(currentConfig?.max_tokens || 2000);
      onConfigUpdate(agent.id, currentConfig || {});
      
      setTimeout(() => setHealthStatus(null), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  const getCostIndicator = (costProfile: string) => {
    const colors = {
      high: 'text-red-400',
      medium: 'text-yellow-400', 
      low: 'text-emerald-400'
    };
    const labels = {
      high: '$$$',
      medium: '$$',
      low: '$'
    };
    return (
      <span className={`text-xs font-mono ${colors[costProfile as keyof typeof colors] || 'text-gray-400'}`}>
        {labels[costProfile as keyof typeof labels] || '$'}
      </span>
    );
  };

  const getStatusIcon = () => {
    if (healthStatus === 'checking') return <Clock className="w-3.5 h-3.5 text-yellow-400 animate-spin" />;
    if (healthStatus === 'healthy') return <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />;
    if (healthStatus === 'unhealthy') return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    if (isModelAvailable) return <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />;
    return <div className="w-2 h-2 bg-gray-600 rounded-full" />;
  };

  const isModelAvailable = compatibleModels.some(m => m.model_string === selectedModel);
  const isActive = currentConfig && isModelAvailable;

  return (
    <div className={`relative rounded-xl overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:shadow-2xl ${
      isActive ? 'ring-1 ring-purple-500/30 shadow-lg shadow-purple-500/10' : ''
    }`}
         style={{ 
           background: isActive 
             ? 'linear-gradient(135deg, rgba(30, 25, 40, 0.9) 0%, rgba(20, 20, 30, 0.95) 100%)'
             : 'linear-gradient(135deg, rgba(20, 20, 30, 0.8) 0%, rgba(15, 15, 25, 0.9) 100%)',
           backdropFilter: 'blur(10px)',
           animation: 'fadeInUp 0.5s ease-out'
         }}>
      
      {/* Gradient border */}
      <div className="absolute inset-0 rounded-xl p-[1px] transition-all duration-300 pointer-events-none" style={{
        background: isActive
          ? 'linear-gradient(180deg, rgba(168, 85, 247, 0.5) 0%, rgba(7, 180, 130, 0.3) 100%)'
          : 'linear-gradient(180deg, rgba(168, 85, 247, 0.3) 0%, rgba(7, 180, 130, 0.1) 100%)'
      }}>
        <div className="w-full h-full rounded-xl" style={{
          background: isActive
            ? 'linear-gradient(135deg, rgba(30, 25, 40, 0.9) 0%, rgba(20, 20, 30, 0.95) 100%)'
            : 'linear-gradient(135deg, rgba(20, 20, 30, 0.8) 0%, rgba(15, 15, 25, 0.9) 100%)'
        }} />
      </div>

      {/* Status Bar for Active Agents or Saving */}
      {(isActive || isSaving) && (
        <div className="absolute top-0 left-0 right-0 h-[3px] animate-shimmer transition-all duration-500 z-10" 
             style={{ 
               background: isSaving 
                 ? 'linear-gradient(90deg, transparent 0%, rgba(251, 191, 36, 1) 25%, rgba(251, 146, 60, 1) 75%, transparent 100%)'
                 : 'linear-gradient(90deg, transparent 0%, rgba(168, 85, 247, 1) 25%, rgba(7, 180, 130, 1) 75%, transparent 100%)',
               backgroundSize: '200% 100%'
             }} />
      )}

      {/* Content */}
      <div className="relative p-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {/* Agent Icon */}
            <div className="w-10 h-10 rounded-lg bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
              <span className="text-xl">{agent.icon}</span>
            </div>
            
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-light text-white">
                  {agent.name}
                </h3>
                <Badge 
                  variant={agent.category === 'agent' ? 'primary' : 'secondary'}
                  className="text-xs px-1.5 py-0.5"
                >
                  {agent.category}
                </Badge>
                {getCostIndicator(agent.costProfile)}
              </div>
              <p className="text-xs text-gray-500">
                {agent.description}
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {getStatusIcon()}
          </div>
        </div>

        {/* Current Configuration Summary */}
        <div className="mt-3 pt-3 border-t border-zinc-800/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3" />
                {selectedModel ? (selectedModel.split(':')[1] || selectedModel) : 'No model selected'}
              </span>
              {agent.supportsTemperature && currentConfig?.temperature !== undefined && (
                <span className="flex items-center gap-1">
                  <Sliders className="w-3 h-3" />
                  {currentConfig.temperature}
                </span>
              )}
              {agent.supportsMaxTokens && currentConfig?.max_tokens !== undefined && (
                <span className="flex items-center gap-1">
                  <Activity className="w-3 h-3" />
                  {currentConfig.max_tokens}
                </span>
              )}
            </div>
            <Button
              onClick={() => setIsModalOpen(true)}
              variant="ghost"
              size="sm"
              className="text-xs flex items-center gap-1"
              disabled={isSaving}
            >
              {isSaving ? (
                <>
                  <Clock className="w-3 h-3 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Edit3 className="w-3 h-3" />
                  Configure
                </>
              )}
            </Button>
          </div>
          
          {!isModelAvailable && selectedModel && (
            <p className="mt-2 text-xs text-yellow-500 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              This model requires an API key to be configured
            </p>
          )}
        </div>

        {/* Model Selection Modal */}
        <ModelSelectionModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          models={compatibleModels}
          currentModel={selectedModel}
          onSelectModel={handleModelSelect}
          agent={agent}
          showAdvancedSettings={true}
        />
      </div>
    </div>
  );
};