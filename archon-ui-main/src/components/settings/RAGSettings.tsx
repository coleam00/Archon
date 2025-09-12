import React, { useState } from 'react';
import { Settings, Check, Save, Loader, ChevronDown, ChevronUp, Zap, Database } from 'lucide-react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { useToast } from '../../contexts/ToastContext';
import { credentialsService } from '../../services/credentialsService';

interface RAGSettingsProps {
  ragSettings: {
    MODEL_CHOICE: string;
    USE_CONTEXTUAL_EMBEDDINGS: boolean;
    CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: number;
    USE_HYBRID_SEARCH: boolean;
    USE_AGENTIC_RAG: boolean;
    USE_RERANKING: boolean;
    LLM_PROVIDER?: string;
    LLM_BASE_URL?: string;
    EMBEDDING_MODEL?: string;
    // Azure OpenAI specific settings
    AZURE_OPENAI_ENDPOINT?: string;
    AZURE_OPENAI_DEPLOYMENT?: string;
    AZURE_OPENAI_API_VERSION?: string;
    // Crawling Performance Settings
    CRAWL_BATCH_SIZE?: number;
    CRAWL_MAX_CONCURRENT?: number;
    CRAWL_WAIT_STRATEGY?: string;
    CRAWL_PAGE_TIMEOUT?: number;
    CRAWL_DELAY_BEFORE_HTML?: number;
    // Storage Performance Settings
    DOCUMENT_STORAGE_BATCH_SIZE?: number;
    EMBEDDING_BATCH_SIZE?: number;
    DELETE_BATCH_SIZE?: number;
    ENABLE_PARALLEL_BATCHES?: boolean;
    // Advanced Settings
    MEMORY_THRESHOLD_PERCENT?: number;
    DISPATCHER_CHECK_INTERVAL?: number;
    CODE_EXTRACTION_BATCH_SIZE?: number;
    CODE_SUMMARY_MAX_WORKERS?: number;
  };
  setRagSettings: (settings: any) => void;
}

export const RAGSettings = ({
  ragSettings,
  setRagSettings
}: RAGSettingsProps) => {
  const [saving, setSaving] = useState(false);
  const [showCrawlingSettings, setShowCrawlingSettings] = useState(false);
  const [showStorageSettings, setShowStorageSettings] = useState(false);
  const { showToast } = useToast();
  return <Card accentColor="green" className="overflow-hidden p-8">
        {/* Description */}
        <p className="text-sm text-gray-600 dark:text-zinc-400 mb-6">
          Configure Retrieval-Augmented Generation (RAG) strategies for optimal
          knowledge retrieval.
        </p>
        
        {/* Provider Selection Row - Dynamic grid based on provider */}
        <div className={`grid gap-4 mb-4 ${ragSettings.LLM_PROVIDER === 'azure-openai' ? 'grid-cols-1' : 'grid-cols-3'}`}>
          <div>
            <Select
              label="LLM Provider"
              value={ragSettings.LLM_PROVIDER || 'openai'}
              onChange={e => setRagSettings({
                ...ragSettings,
                LLM_PROVIDER: e.target.value
              })}
              accentColor="green"
              options={[
                { value: 'openai', label: 'OpenAI' },
                { value: 'azure-openai', label: 'Azure OpenAI' },
                { value: 'google', label: 'Google Gemini' },
                { value: 'ollama', label: 'Ollama (Coming Soon)' },
              ]}
            />
          </div>
          {ragSettings.LLM_PROVIDER === 'ollama' && (
            <div>
              <Input
                label="Ollama Base URL"
                value={ragSettings.LLM_BASE_URL || 'http://localhost:11434/v1'}
                onChange={e => setRagSettings({
                  ...ragSettings,
                  LLM_BASE_URL: e.target.value
                })}
                placeholder="http://localhost:11434/v1"
                accentColor="green"
              />
            </div>
          )}
        </div>

        {/* Azure-specific fields in separate section */}
        {ragSettings.LLM_PROVIDER === 'azure-openai' && (
          <div className="mb-4 p-4 border border-blue-500/20 rounded-lg bg-blue-500/5">
            {/* Azure Configuration Help */}
            <div className="mb-4 p-3 bg-blue-100 dark:bg-blue-800/30 border border-blue-300 dark:border-blue-600 rounded-md">
              <div className="text-sm text-blue-800 dark:text-blue-200">
                <p className="font-medium mb-1">💡 Azure Setup Guide:</p>
                <p>1. Add your <code className="bg-blue-200 dark:bg-blue-700 px-1 rounded">AZURE_OPENAI_API_KEY</code> in the API Keys section</p>
                <p>2. Configure the fields below with your Azure OpenAI resource details</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <Input
                  label="Azure Endpoint"
                  value={ragSettings.AZURE_OPENAI_ENDPOINT || ''}
                  onChange={e => setRagSettings({
                    ...ragSettings,
                    AZURE_OPENAI_ENDPOINT: e.target.value
                  })}
                  placeholder="https://your-resource.openai.azure.com"
                  accentColor="green"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Your Azure OpenAI resource endpoint</p>
              </div>
              <div>
                <Input
                  label="Azure Deployment Name"
                  value={ragSettings.AZURE_OPENAI_DEPLOYMENT || ''}
                  onChange={e => setRagSettings({
                    ...ragSettings,
                    AZURE_OPENAI_DEPLOYMENT: e.target.value
                  })}
                  placeholder="your-deployment-name"
                  accentColor="green"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Model deployment name from Azure OpenAI Studio</p>
              </div>
              <div>
                <Input
                  label="Azure API Version"
                  value={ragSettings.AZURE_OPENAI_API_VERSION || '2024-10-21'}
                  onChange={e => setRagSettings({
                    ...ragSettings,
                    AZURE_OPENAI_API_VERSION: e.target.value
                  })}
                  placeholder="2024-10-21"
                  accentColor="green"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">API version (e.g., 2024-10-21)</p>
              </div>
            </div>
          </div>
        )}

        {/* Save Button Row */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="col-span-3"></div>
          <div className="flex items-end">
            <Button 
              variant="outline" 
              accentColor="green" 
              icon={saving ? <Loader className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
              className="w-full whitespace-nowrap"
              size="md"
              onClick={async () => {
                try {
                  setSaving(true);
                  await credentialsService.updateRagSettings(ragSettings);
                  showToast('RAG settings saved successfully!', 'success');
                } catch (err) {
                  console.error('Failed to save RAG settings:', err);
                  showToast('Failed to save settings', 'error');
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </div>

        {/* Model Settings Row */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <Input 
              label="Chat Model" 
              value={ragSettings.MODEL_CHOICE} 
              onChange={e => setRagSettings({
                ...ragSettings,
                MODEL_CHOICE: e.target.value
              })} 
              placeholder={getModelPlaceholder(ragSettings.LLM_PROVIDER || 'openai')}
              accentColor="green" 
            />
          </div>
          <div>
            <Input
              label="Embedding Model"
              value={ragSettings.EMBEDDING_MODEL || ''}
              onChange={e => setRagSettings({
                ...ragSettings,
                EMBEDDING_MODEL: e.target.value
              })}
              placeholder={getEmbeddingPlaceholder(ragSettings.LLM_PROVIDER || 'openai')}
              accentColor="green"
            />
          </div>
        </div>
        
        {/* Second row: Contextual Embeddings, Max Workers, and description */}
        <div className="grid grid-cols-8 gap-4 mb-4 p-4 rounded-lg border border-green-500/20 shadow-[0_2px_8px_rgba(34,197,94,0.1)]">
          <div className="col-span-4">
            <CustomCheckbox 
              id="contextualEmbeddings" 
              checked={ragSettings.USE_CONTEXTUAL_EMBEDDINGS} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_CONTEXTUAL_EMBEDDINGS: e.target.checked
              })} 
              label="Use Contextual Embeddings" 
              description="Enhances embeddings with contextual information for better retrieval" 
            />
          </div>
                      <div className="col-span-1">
              {ragSettings.USE_CONTEXTUAL_EMBEDDINGS && (
                <div className="flex flex-col items-center">
                  <div className="relative ml-2 mr-6">
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={ragSettings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS}
                      onChange={e => setRagSettings({
                        ...ragSettings,
                        CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: parseInt(e.target.value, 10) || 3
                      })}
                      className="w-14 h-10 pl-1 pr-7 text-center font-medium rounded-md 
                        bg-gradient-to-b from-gray-100 to-gray-200 dark:from-gray-900 dark:to-black 
                        border border-green-500/30 
                        text-gray-900 dark:text-white
                        focus:border-green-500 focus:shadow-[0_0_15px_rgba(34,197,94,0.4)]
                        transition-all duration-200
                        [appearance:textfield] 
                        [&::-webkit-outer-spin-button]:appearance-none 
                        [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <div className="absolute right-1 top-1 bottom-1 flex flex-col">
                      <button
                        type="button"
                        onClick={() => setRagSettings({
                          ...ragSettings,
                          CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: Math.min(ragSettings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS + 1, 10)
                        })}
                        className="flex-1 px-1 rounded-t-sm 
                          bg-gradient-to-b from-green-500/20 to-green-600/10
                          hover:from-green-500/30 hover:to-green-600/20
                          border border-green-500/30 border-b-0
                          transition-all duration-200 group"
                      >
                        <svg className="w-2.5 h-2.5 text-green-500 group-hover:filter group-hover:drop-shadow-[0_0_4px_rgba(34,197,94,0.8)]" 
                          viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 5L5 1L9 5" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => setRagSettings({
                          ...ragSettings,
                          CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: Math.max(ragSettings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS - 1, 1)
                        })}
                        className="flex-1 px-1 rounded-b-sm 
                          bg-gradient-to-b from-green-500/20 to-green-600/10
                          hover:from-green-500/30 hover:to-green-600/20
                          border border-green-500/30 border-t-0
                          transition-all duration-200 group"
                      >
                        <svg className="w-2.5 h-2.5 text-green-500 group-hover:filter group-hover:drop-shadow-[0_0_4px_rgba(34,197,94,0.8)]" 
                          viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 1L5 5L9 1" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Max
                  </label>
                </div>
              )}
            </div>
          <div className="col-span-3">
            {ragSettings.USE_CONTEXTUAL_EMBEDDINGS && (
              <p className="text-xs text-green-900 dark:text-blue-600 mt-2">
                Controls parallel processing for embeddings (1-10)
              </p>
            )}
          </div>
        </div>
        
        {/* Third row: Hybrid Search and Agentic RAG */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <CustomCheckbox 
              id="hybridSearch" 
              checked={ragSettings.USE_HYBRID_SEARCH} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_HYBRID_SEARCH: e.target.checked
              })} 
              label="Use Hybrid Search" 
              description="Combines vector similarity search with keyword search for better results" 
            />
          </div>
          <div>
            <CustomCheckbox 
              id="agenticRag" 
              checked={ragSettings.USE_AGENTIC_RAG} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_AGENTIC_RAG: e.target.checked
              })} 
              label="Use Agentic RAG" 
              description="Enables code extraction and specialized search for technical content" 
            />
          </div>
        </div>
        
        {/* Fourth row: Use Reranking */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <CustomCheckbox 
              id="reranking" 
              checked={ragSettings.USE_RERANKING} 
              onChange={e => setRagSettings({
                ...ragSettings,
                USE_RERANKING: e.target.checked
              })} 
              label="Use Reranking" 
              description="Applies cross-encoder reranking to improve search result relevance" 
            />
          </div>
          <div>{/* Empty column */}</div>
        </div>

        {/* Crawling Performance Settings */}
        <div className="mt-6">
          <div
            className="flex items-center justify-between cursor-pointer p-3 rounded-lg border border-green-500/20 bg-gradient-to-r from-green-500/5 to-green-600/5 hover:from-green-500/10 hover:to-green-600/10 transition-all duration-200"
            onClick={() => setShowCrawlingSettings(!showCrawlingSettings)}
          >
            <div className="flex items-center">
              <Zap className="mr-2 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" size={18} />
              <h3 className="font-semibold text-gray-800 dark:text-white">Crawling Performance Settings</h3>
            </div>
            {showCrawlingSettings ? (
              <ChevronUp className="text-gray-500 dark:text-gray-400" size={20} />
            ) : (
              <ChevronDown className="text-gray-500 dark:text-gray-400" size={20} />
            )}
          </div>
          
          {showCrawlingSettings && (
            <div className="mt-4 p-4 border border-green-500/10 rounded-lg bg-green-500/5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Batch Size
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="100"
                    value={ragSettings.CRAWL_BATCH_SIZE || 50}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_BATCH_SIZE: parseInt(e.target.value, 10) || 50
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">URLs to crawl in parallel (10-100)</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Max Concurrent
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={ragSettings.CRAWL_MAX_CONCURRENT || 10}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_MAX_CONCURRENT: parseInt(e.target.value, 10) || 10
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Pages to crawl in parallel per operation (1-20)</p>
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4 mt-4">
                <div>
                  <Select
                    label="Wait Strategy"
                    value={ragSettings.CRAWL_WAIT_STRATEGY || 'domcontentloaded'}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_WAIT_STRATEGY: e.target.value
                    })}
                    accentColor="green"
                    options={[
                      { value: 'domcontentloaded', label: 'DOM Loaded (Fast)' },
                      { value: 'networkidle', label: 'Network Idle (Thorough)' },
                      { value: 'load', label: 'Full Load (Slowest)' }
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Page Timeout (sec)
                  </label>
                  <input
                    type="number"
                    min="5"
                    max="120"
                    value={(ragSettings.CRAWL_PAGE_TIMEOUT || 60000) / 1000}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_PAGE_TIMEOUT: (parseInt(e.target.value, 10) || 60) * 1000
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Render Delay (sec)
                  </label>
                  <input
                    type="number"
                    min="0.1"
                    max="5"
                    step="0.1"
                    value={ragSettings.CRAWL_DELAY_BEFORE_HTML || 0.5}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CRAWL_DELAY_BEFORE_HTML: parseFloat(e.target.value) || 0.5
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Storage Performance Settings */}
        <div className="mt-4">
          <div
            className="flex items-center justify-between cursor-pointer p-3 rounded-lg border border-green-500/20 bg-gradient-to-r from-green-500/5 to-green-600/5 hover:from-green-500/10 hover:to-green-600/10 transition-all duration-200"
            onClick={() => setShowStorageSettings(!showStorageSettings)}
          >
            <div className="flex items-center">
              <Database className="mr-2 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" size={18} />
              <h3 className="font-semibold text-gray-800 dark:text-white">Storage Performance Settings</h3>
            </div>
            {showStorageSettings ? (
              <ChevronUp className="text-gray-500 dark:text-gray-400" size={20} />
            ) : (
              <ChevronDown className="text-gray-500 dark:text-gray-400" size={20} />
            )}
          </div>
          
          {showStorageSettings && (
            <div className="mt-4 p-4 border border-green-500/10 rounded-lg bg-green-500/5">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Document Batch Size
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="100"
                    value={ragSettings.DOCUMENT_STORAGE_BATCH_SIZE || 50}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      DOCUMENT_STORAGE_BATCH_SIZE: parseInt(e.target.value, 10) || 50
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Chunks per batch (10-100)</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Embedding Batch Size
                  </label>
                  <input
                    type="number"
                    min="20"
                    max="200"
                    value={ragSettings.EMBEDDING_BATCH_SIZE || 100}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      EMBEDDING_BATCH_SIZE: parseInt(e.target.value, 10) || 100
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Per API call (20-200)</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Code Extraction Workers
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={ragSettings.CODE_SUMMARY_MAX_WORKERS || 3}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      CODE_SUMMARY_MAX_WORKERS: parseInt(e.target.value, 10) || 3
                    })}
                    className="w-full px-3 py-2 border border-green-500/30 rounded-md bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Parallel workers (1-10)</p>
                </div>
              </div>
              
              <div className="mt-4 flex items-center">
                <CustomCheckbox
                  id="parallelBatches"
                  checked={ragSettings.ENABLE_PARALLEL_BATCHES !== false}
                  onChange={e => setRagSettings({
                    ...ragSettings,
                    ENABLE_PARALLEL_BATCHES: e.target.checked
                  })}
                  label="Enable Parallel Processing"
                  description="Process multiple document batches simultaneously for faster storage"
                />
              </div>
            </div>
          )}
        </div>
    </Card>;
};

// Helper functions for model placeholders
function getModelPlaceholder(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'e.g., gpt-4o-mini';
    case 'azure-openai':
      return 'e.g., gpt-4o-mini';
    case 'ollama':
      return 'e.g., llama2, mistral';
    case 'google':
      return 'e.g., gemini-1.5-flash';
    default:
      return 'e.g., gpt-4o-mini';
  }
}

function getEmbeddingPlaceholder(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'Default: text-embedding-3-small';
    case 'azure-openai':
      return 'Default: text-embedding-3-small';
    case 'ollama':
      return 'e.g., nomic-embed-text';
    case 'google':
      return 'e.g., text-embedding-004';
    default:
      return 'Default: text-embedding-3-small';
  }
}

interface CustomCheckboxProps {
  id: string;
  checked: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
  description: string;
}

const CustomCheckbox = ({
  id,
  checked,
  onChange,
  label,
  description
}: CustomCheckboxProps) => {
  return (
    <div className="flex items-start group">
      <div className="relative flex items-center h-5 mt-1">
        <input 
          type="checkbox" 
          id={id} 
          checked={checked} 
          onChange={onChange} 
          className="sr-only peer" 
        />
        <label 
          htmlFor={id}
          className="relative w-5 h-5 rounded-md transition-all duration-200 cursor-pointer
            bg-gradient-to-b from-white/80 to-white/60 dark:from-white/5 dark:to-black/40
            border border-gray-300 dark:border-gray-700
            peer-checked:border-green-500 dark:peer-checked:border-green-500/50
            peer-checked:bg-gradient-to-b peer-checked:from-green-500/20 peer-checked:to-green-600/20
            group-hover:border-green-500/50 dark:group-hover:border-green-500/30
            peer-checked:shadow-[0_0_10px_rgba(34,197,94,0.2)] dark:peer-checked:shadow-[0_0_15px_rgba(34,197,94,0.3)]"
        >
          <Check className={`
              w-3.5 h-3.5 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
              transition-all duration-200 text-green-500 pointer-events-none
              ${checked ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}
            `} />
        </label>
      </div>
      <div className="ml-3 flex-1">
        <label htmlFor={id} className="text-gray-700 dark:text-zinc-300 font-medium cursor-pointer block text-sm">
          {label}
        </label>
        <p className="text-xs text-gray-600 dark:text-zinc-400 mt-0.5 leading-tight">
          {description}
        </p>
      </div>
    </div>
  );
};