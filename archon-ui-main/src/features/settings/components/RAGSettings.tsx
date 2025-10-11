import { useState } from 'react';
import { Save, Loader, ChevronDown, ChevronUp, Zap, Database, Settings } from 'lucide-react';
import { Card } from '@/features/ui/primitives/card';
import { Input, Label, FormField, FormGrid } from '@/features/ui/primitives/input';
import { Button } from '@/features/ui/primitives/button';
import { Checkbox } from '@/features/ui/primitives/checkbox';
import { useToast } from '../../shared/hooks/useToast';
import { credentialsService } from '../../../services/credentialsService';

interface RagSettings {
  USE_CONTEXTUAL_EMBEDDINGS: boolean;
  CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: number;
  USE_HYBRID_SEARCH: boolean;
  USE_AGENTIC_RAG: boolean;
  USE_RERANKING: boolean;
  CRAWL_BATCH_SIZE?: number;
  CRAWL_MAX_CONCURRENT?: number;
  CRAWL_WAIT_STRATEGY?: string;
  CRAWL_PAGE_TIMEOUT?: number;
  CRAWL_DELAY_BEFORE_HTML?: number;
  DOCUMENT_STORAGE_BATCH_SIZE?: number;
  EMBEDDING_BATCH_SIZE?: number;
  DELETE_BATCH_SIZE?: number;
  ENABLE_PARALLEL_BATCHES?: boolean;
  MEMORY_THRESHOLD_PERCENT?: number;
  DISPATCHER_CHECK_INTERVAL?: number;
  CODE_EXTRACTION_BATCH_SIZE?: number;
  CODE_SUMMARY_MAX_WORKERS?: number;
}

interface RAGSettingsProps {
  ragSettings: RagSettings;
  setRagSettings: (settings: RagSettings) => void;
}

export const RAGSettings = ({ ragSettings, setRagSettings }: RAGSettingsProps) => {
  const [saving, setSaving] = useState(false);
  const [showCrawlingSettings, setShowCrawlingSettings] = useState(false);
  const [showStorageSettings, setShowStorageSettings] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const { showToast } = useToast();

  const handleSave = async () => {
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
  };

  return (
    <Card edgePosition="top" edgeColor="green">
      <div className="flex justify-between items-center mb-6">
        <p className="text-sm text-gray-600 dark:text-zinc-400">
          Configure RAG search strategies and performance settings
        </p>
        <Button
          variant="outline"
          onClick={handleSave}
          disabled={saving}
          size="sm"
        >
          {saving ? <Loader className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="contextualEmbeddings"
            checked={ragSettings.USE_CONTEXTUAL_EMBEDDINGS}
            onCheckedChange={(checked) => setRagSettings({
              ...ragSettings,
              USE_CONTEXTUAL_EMBEDDINGS: checked as boolean
            })}
            color="green"
          />
          <div className="flex-1">
            <Label htmlFor="contextualEmbeddings" className="cursor-pointer">
              Use Contextual Embeddings
            </Label>
            <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
              Enhances embeddings with contextual information for better retrieval
            </p>
          </div>
          {ragSettings.USE_CONTEXTUAL_EMBEDDINGS && (
            <div className="flex items-center gap-2">
              <Label className="text-xs text-gray-500">Max Workers:</Label>
              <Input
                type="number"
                min="1"
                max="10"
                value={ragSettings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS}
                onChange={(e) => setRagSettings({
                  ...ragSettings,
                  CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: parseInt(e.target.value, 10) || 3
                })}
                className="w-16 text-center"
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="hybridSearch"
            checked={ragSettings.USE_HYBRID_SEARCH}
            onCheckedChange={(checked) => setRagSettings({
              ...ragSettings,
              USE_HYBRID_SEARCH: checked as boolean
            })}
            color="green"
          />
          <div className="flex-1">
            <Label htmlFor="hybridSearch" className="cursor-pointer">
              Use Hybrid Search
            </Label>
            <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
              Combines vector similarity search with keyword search for better results
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="agenticRag"
            checked={ragSettings.USE_AGENTIC_RAG}
            onCheckedChange={(checked) => setRagSettings({
              ...ragSettings,
              USE_AGENTIC_RAG: checked as boolean
            })}
            color="green"
          />
          <div className="flex-1">
            <Label htmlFor="agenticRag" className="cursor-pointer">
              Use Agentic RAG
            </Label>
            <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
              Enables code extraction and specialized search for technical content
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="reranking"
            checked={ragSettings.USE_RERANKING}
            onCheckedChange={(checked) => setRagSettings({
              ...ragSettings,
              USE_RERANKING: checked as boolean
            })}
            color="green"
          />
          <div className="flex-1">
            <Label htmlFor="reranking" className="cursor-pointer">
              Use Reranking
            </Label>
            <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
              Applies cross-encoder reranking to improve search result relevance
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <button
          type="button"
          className="flex items-center justify-between w-full cursor-pointer p-3 rounded-lg border border-green-500/20 bg-gradient-to-r from-green-500/5 to-green-600/5 hover:from-green-500/10 hover:to-green-600/10 transition-all duration-200"
          onClick={() => setShowCrawlingSettings(!showCrawlingSettings)}
        >
          <div className="flex items-center">
            <Zap className="mr-2 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" size={18} />
            <h3 className="font-semibold text-gray-800 dark:text-white text-sm">Crawling Performance Settings</h3>
          </div>
          {showCrawlingSettings ? (
            <ChevronUp className="text-gray-500 dark:text-gray-400" size={20} />
          ) : (
            <ChevronDown className="text-gray-500 dark:text-gray-400" size={20} />
          )}
        </button>

        {showCrawlingSettings && (
          <div className="p-4 bg-green-500/5 rounded-lg border border-green-500/20">
            <FormGrid columns={2}>
              <FormField>
                <Label>Batch Size</Label>
                <Input
                  type="number"
                  min="10"
                  max="200"
                  value={ragSettings.CRAWL_BATCH_SIZE || 50}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    CRAWL_BATCH_SIZE: parseInt(e.target.value, 10) || 50
                  })}
                />
              </FormField>

              <FormField>
                <Label>Max Concurrent</Label>
                <Input
                  type="number"
                  min="1"
                  max="50"
                  value={ragSettings.CRAWL_MAX_CONCURRENT || 10}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    CRAWL_MAX_CONCURRENT: parseInt(e.target.value, 10) || 10
                  })}
                />
              </FormField>

              <FormField>
                <Label>Page Timeout (ms)</Label>
                <Input
                  type="number"
                  min="10000"
                  max="120000"
                  value={ragSettings.CRAWL_PAGE_TIMEOUT || 60000}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    CRAWL_PAGE_TIMEOUT: parseInt(e.target.value, 10) || 60000
                  })}
                />
              </FormField>

              <FormField>
                <Label>Delay Before HTML (s)</Label>
                <Input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={ragSettings.CRAWL_DELAY_BEFORE_HTML || 0.5}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    CRAWL_DELAY_BEFORE_HTML: parseFloat(e.target.value) || 0.5
                  })}
                />
              </FormField>
            </FormGrid>
          </div>
        )}

        <button
          type="button"
          className="flex items-center justify-between w-full cursor-pointer p-3 rounded-lg border border-green-500/20 bg-gradient-to-r from-green-500/5 to-green-600/5 hover:from-green-500/10 hover:to-green-600/10 transition-all duration-200"
          onClick={() => setShowStorageSettings(!showStorageSettings)}
        >
          <div className="flex items-center">
            <Database className="mr-2 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" size={18} />
            <h3 className="font-semibold text-gray-800 dark:text-white text-sm">Storage Performance Settings</h3>
          </div>
          {showStorageSettings ? (
            <ChevronUp className="text-gray-500 dark:text-gray-400" size={20} />
          ) : (
            <ChevronDown className="text-gray-500 dark:text-gray-400" size={20} />
          )}
        </button>

        {showStorageSettings && (
          <div className="p-4 bg-green-500/5 rounded-lg border border-green-500/20">
            <FormGrid columns={2}>
              <FormField>
                <Label>Document Storage Batch Size</Label>
                <Input
                  type="number"
                  min="10"
                  max="200"
                  value={ragSettings.DOCUMENT_STORAGE_BATCH_SIZE || 50}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    DOCUMENT_STORAGE_BATCH_SIZE: parseInt(e.target.value, 10) || 50
                  })}
                />
              </FormField>

              <FormField>
                <Label>Embedding Batch Size</Label>
                <Input
                  type="number"
                  min="10"
                  max="500"
                  value={ragSettings.EMBEDDING_BATCH_SIZE || 100}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    EMBEDDING_BATCH_SIZE: parseInt(e.target.value, 10) || 100
                  })}
                />
              </FormField>

              <FormField>
                <Label>Delete Batch Size</Label>
                <Input
                  type="number"
                  min="10"
                  max="500"
                  value={ragSettings.DELETE_BATCH_SIZE || 100}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    DELETE_BATCH_SIZE: parseInt(e.target.value, 10) || 100
                  })}
                />
              </FormField>

              <FormField>
                <div className="flex items-center justify-between mt-6">
                  <Label htmlFor="parallelBatches">Enable Parallel Batches</Label>
                  <Checkbox
                    id="parallelBatches"
                    checked={ragSettings.ENABLE_PARALLEL_BATCHES ?? true}
                    onCheckedChange={(checked) => setRagSettings({
                      ...ragSettings,
                      ENABLE_PARALLEL_BATCHES: checked as boolean
                    })}
                    color="green"
                  />
                </div>
              </FormField>
            </FormGrid>
          </div>
        )}

        <button
          type="button"
          className="flex items-center justify-between w-full cursor-pointer p-3 rounded-lg border border-green-500/20 bg-gradient-to-r from-green-500/5 to-green-600/5 hover:from-green-500/10 hover:to-green-600/10 transition-all duration-200"
          onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
        >
          <div className="flex items-center">
            <Settings className="mr-2 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]" size={18} />
            <h3 className="font-semibold text-gray-800 dark:text-white text-sm">Advanced Settings</h3>
          </div>
          {showAdvancedSettings ? (
            <ChevronUp className="text-gray-500 dark:text-gray-400" size={20} />
          ) : (
            <ChevronDown className="text-gray-500 dark:text-gray-400" size={20} />
          )}
        </button>

        {showAdvancedSettings && (
          <div className="p-4 bg-green-500/5 rounded-lg border border-green-500/20">
            <FormGrid columns={2}>
              <FormField>
                <Label>Memory Threshold (%)</Label>
                <Input
                  type="number"
                  min="50"
                  max="95"
                  value={ragSettings.MEMORY_THRESHOLD_PERCENT || 80}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    MEMORY_THRESHOLD_PERCENT: parseInt(e.target.value, 10) || 80
                  })}
                />
              </FormField>

              <FormField>
                <Label>Dispatcher Check Interval (s)</Label>
                <Input
                  type="number"
                  min="10"
                  max="300"
                  value={ragSettings.DISPATCHER_CHECK_INTERVAL || 30}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    DISPATCHER_CHECK_INTERVAL: parseInt(e.target.value, 10) || 30
                  })}
                />
              </FormField>

              <FormField>
                <Label>Code Extraction Batch Size</Label>
                <Input
                  type="number"
                  min="10"
                  max="200"
                  value={ragSettings.CODE_EXTRACTION_BATCH_SIZE || 50}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    CODE_EXTRACTION_BATCH_SIZE: parseInt(e.target.value, 10) || 50
                  })}
                />
              </FormField>

              <FormField>
                <Label>Code Summary Max Workers</Label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={ragSettings.CODE_SUMMARY_MAX_WORKERS || 3}
                  onChange={(e) => setRagSettings({
                    ...ragSettings,
                    CODE_SUMMARY_MAX_WORKERS: parseInt(e.target.value, 10) || 3
                  })}
                />
              </FormField>
            </FormGrid>
          </div>
        )}
      </div>
    </Card>
  );
};
