/**
 * Agents Configuration Page
 * 
 * Agent-centric provider configuration where users select models for each agent/service
 */

import React, { useState, useEffect } from 'react';
import {
  Brain,
  Key,
  ChevronDown,
  AlertCircle,
} from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { cleanProviderService } from '../services/cleanProviderService';
import { ProviderSettings } from '../components/settings/ProviderSettings';
import { AgentCard } from '../components/agents/AgentCard';
import { getAgents, getServices } from '../types/agent';
import type { AvailableModel, ModelConfig } from '../types/cleanProvider';

export const AgentsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'agents' | 'services'>('agents');
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [agentConfigs, setAgentConfigs] = useState<Record<string, ModelConfig>>({});
  const [loading, setLoading] = useState(true);
  
  const { showToast } = useToast();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      
      // Load models and configs first (critical)
      const [models, configs] = await Promise.all([
        cleanProviderService.getAvailableModels(),
        cleanProviderService.getAllAgentConfigs()
      ]);
      
      console.log('Loaded models:', models);
      console.log('Models count:', models?.length);
      console.log('First model:', models?.[0]);
      
      setAvailableModels(models || []);
      setAgentConfigs(configs || {});
      
      // Check if any API keys are configured
      const activeProviders = await cleanProviderService.getActiveProviders();
      console.log('Active providers:', activeProviders);
      
      if (activeProviders.length === 0) {
        setShowApiKeys(true);
      }
    } catch (error) {
      console.error('Failed to load critical data:', error);
      showToast('Failed to load configuration', 'error');
      // Set empty defaults on error
      setAvailableModels([]);
      setAgentConfigs({});
    } finally {
      setLoading(false);
    }
  };

  const handleConfigUpdate = async (agentId: string, config: any) => {
    // Optimistically update the local state immediately
    setAgentConfigs(prev => ({
      ...prev,
      [agentId]: config
    }));
    
    // Don't reload all data - the configuration is already saved on the backend
    // by the AgentCard component, and we've updated local state optimistically
  };

  const handleProviderAdded = async () => {
    // Only reload models when a provider is added, not all data
    try {
      const models = await cleanProviderService.getAvailableModels();
      setAvailableModels(models || []);
    } catch (error) {
      console.error('Failed to reload models after provider added:', error);
    }
  };

  const agents = getAgents();
  const services = getServices();
  const currentItems = activeTab === 'agents' ? agents : services;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 dark:border-white"></div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <Brain className="w-8 h-8 text-blue-600 dark:text-blue-400" />
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Agent Configuration
          </h1>
        </div>
        <p className="text-gray-600 dark:text-gray-400">
          Configure which AI models power your agents and services
        </p>
      </div>

      {/* API Keys Section (Collapsible) */}
      <div className="mb-8">
        <div 
          className="relative rounded-xl transition-all duration-300 hover:scale-[1.005] cursor-pointer"
          style={{
            background: showApiKeys
              ? 'linear-gradient(135deg, rgba(30, 25, 40, 0.9) 0%, rgba(20, 20, 30, 0.95) 100%)'
              : 'linear-gradient(135deg, rgba(20, 20, 30, 0.7) 0%, rgba(15, 15, 25, 0.8) 100%)',
            backdropFilter: 'blur(10px)'
          }}
          onClick={() => !showApiKeys && setShowApiKeys(true)}
        >
          {/* Gradient border */}
          <div className="absolute inset-0 rounded-xl p-[1px] pointer-events-none" style={{
            background: showApiKeys
              ? 'linear-gradient(180deg, rgba(168, 85, 247, 0.4) 0%, rgba(7, 180, 130, 0.2) 100%)'
              : 'linear-gradient(180deg, rgba(168, 85, 247, 0.2) 0%, rgba(7, 180, 130, 0.1) 100%)'
          }}>
            <div className="w-full h-full rounded-xl" style={{
              background: showApiKeys
                ? 'linear-gradient(135deg, rgba(30, 25, 40, 0.9) 0%, rgba(20, 20, 30, 0.95) 100%)'
                : 'linear-gradient(135deg, rgba(20, 20, 30, 0.7) 0%, rgba(15, 15, 25, 0.8) 100%)'
            }} />
          </div>

          {/* Collapsible Header */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowApiKeys(!showApiKeys);
            }}
            className="relative w-full p-4 flex items-center justify-between group"
          >
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                showApiKeys 
                  ? 'bg-gradient-to-br from-purple-600/30 to-purple-500/20 border border-purple-500/30' 
                  : 'bg-zinc-800/50 border border-zinc-700/50'
              }`}>
                <Key className={`w-5 h-5 ${showApiKeys ? 'text-purple-400' : 'text-gray-400'}`} />
              </div>
              <div className="text-left">
                <h2 className="text-sm font-light text-white">
                  API Key Configuration
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {availableModels.length > 0 
                    ? <>
                        <span className="text-emerald-400">{new Set(availableModels.map(m => m.provider)).size}</span>
                        {' providers active • '}
                        <span className="text-blue-400">{availableModels.length}</span>
                        {' models available'}
                      </>
                    : <span className="text-yellow-400">⚠️ No providers configured - add API keys to get started</span>
                  }
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              {!showApiKeys && availableModels.length === 0 && (
                <span className="px-2 py-0.5 text-xs rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 animate-pulse">
                  Setup Required
                </span>
              )}
              <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform group-hover:text-gray-300 ${
                showApiKeys ? 'rotate-180' : ''
              }`} />
            </div>
          </button>

          {/* Expanded Content */}
          {showApiKeys && (
            <div className="relative px-4 pb-4">
              <div className="border-t border-zinc-800/50 pt-4">
                {/* Scrollable container for provider settings */}
                <div className="max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                  <ProviderSettings onProviderAdded={handleProviderAdded} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* No Models Warning */}
      {availableModels.length === 0 && !showApiKeys && (
        <div className="mb-8 relative rounded-xl p-4"
             style={{
               background: 'linear-gradient(135deg, rgba(30, 25, 20, 0.9) 0%, rgba(25, 20, 15, 0.95) 100%)',
               backdropFilter: 'blur(10px)'
             }}>
          <div className="absolute inset-0 rounded-xl p-[1px] pointer-events-none" style={{
            background: 'linear-gradient(180deg, rgba(251, 191, 36, 0.3) 0%, rgba(251, 191, 36, 0.1) 100%)'
          }}>
            <div className="w-full h-full rounded-xl" style={{
              background: 'linear-gradient(135deg, rgba(30, 25, 20, 0.9) 0%, rgba(25, 20, 15, 0.95) 100%)'
            }} />
          </div>
          
          <div className="relative flex gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-yellow-400 font-medium text-sm">
                Configuration Required
              </p>
              <p className="text-yellow-400/70 text-xs mt-1">
                Click "API Key Configuration" above to add provider credentials and enable AI agents
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex gap-4 mb-6 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('agents')}
          className={`pb-3 px-1 border-b-2 transition-colors ${
            activeTab === 'agents'
              ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <span>AI Agents</span>
            <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
              {agents.length}
            </span>
          </div>
        </button>
        <button
          onClick={() => setActiveTab('services')}
          className={`pb-3 px-1 border-b-2 transition-colors ${
            activeTab === 'services'
              ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <span>Backend Services</span>
            <span className="px-2 py-0.5 text-xs rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">
              {services.length}
            </span>
          </div>
        </button>
      </div>

      {/* Agent/Service Cards */}
      <div className="space-y-4 mb-8">
        {currentItems.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            availableModels={availableModels}
            currentConfig={agentConfigs[agent.id]}
            onConfigUpdate={handleConfigUpdate}
          />
        ))}
      </div>

    </div>
  );
};