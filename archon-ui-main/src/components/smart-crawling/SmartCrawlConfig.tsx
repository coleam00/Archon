/**
 * Smart Crawling Mode Configuration Components
 * 
 * Provides UI components for configuring and managing different crawling modes
 * including e-commerce, blog, documentation, and analytics modes.
 */

import React, { useState, useEffect } from 'react';
import { 
  Settings, 
  ShoppingCart, 
  FileText, 
  BookOpen, 
  BarChart3,
  Globe,
  Save,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
  Loader2
} from 'lucide-react';

// Types
interface CrawlModeConfig {
  mode_name: string;
  enabled: boolean;
  priority: string;
  max_pages: number;
  max_depth: number;
  concurrent_requests: number;
  delay_between_requests: number;
  custom_settings: Record<string, any>;
}

interface CrawlMode {
  name: string;
  enabled: boolean;
  description: string;
  supported_websites: string[];
  configuration: CrawlModeConfig;
}

// Main configuration panel
export const SmartCrawlConfigPanel: React.FC = () => {
  const [modes, setModes] = useState<CrawlMode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadCrawlingModes();
  }, []);

  const loadCrawlingModes = async () => {
    try {
      const response = await fetch('/api/smart-crawl/modes');
      const data = await response.json();
      if (data.success) {
        setModes(data.modes);
      }
    } catch (error) {
      console.error('Failed to load crawling modes:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleModeUpdate = async (modeName: string, config: CrawlModeConfig) => {
    setSaving(true);
    try {
      const response = await fetch(`/api/smart-crawl/modes/${modeName}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });

      if (response.ok) {
        await loadCrawlingModes(); // Refresh data
      }
    } catch (error) {
      console.error('Failed to update mode:', error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        <span>Loading crawling modes...</span>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6" />
          Smart Crawling Configuration
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Mode Selection */}
        <div className="lg:col-span-1">
          <h3 className="text-lg font-semibold mb-4">Crawling Modes</h3>
          <div className="space-y-2">
            {modes.map((mode) => (
              <ModeCard
                key={mode.name}
                mode={mode}
                isSelected={selectedMode === mode.name}
                onSelect={() => setSelectedMode(mode.name)}
              />
            ))}
          </div>
        </div>

        {/* Configuration Panel */}
        <div className="lg:col-span-2">
          {selectedMode ? (
            <ModeConfigEditor
              mode={modes.find(m => m.name === selectedMode)!}
              onUpdate={handleModeUpdate}
              saving={saving}
            />
          ) : (
            <div className="bg-gray-50 rounded-lg p-8 text-center">
              <Globe className="w-12 h-12 mx-auto text-gray-400 mb-4" />
              <p className="text-gray-600">Select a crawling mode to configure</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Individual mode card
const ModeCard: React.FC<{
  mode: CrawlMode;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ mode, isSelected, onSelect }) => {
  const getModeIcon = (modeName: string) => {
    switch (modeName) {
      case 'ecommerce': return <ShoppingCart className="w-5 h-5" />;
      case 'blog': return <FileText className="w-5 h-5" />;
      case 'documentation': return <BookOpen className="w-5 h-5" />;
      case 'analytics': return <BarChart3 className="w-5 h-5" />;
      default: return <Globe className="w-5 h-5" />;
    }
  };

  return (
    <div
      onClick={onSelect}
      className={`
        p-4 rounded-lg border-2 cursor-pointer transition-all
        ${isSelected 
          ? 'border-blue-500 bg-blue-50' 
          : 'border-gray-200 hover:border-gray-300 bg-white'
        }
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`
          p-2 rounded-md
          ${isSelected ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}
        `}>
          {getModeIcon(mode.name)}
        </div>
        
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-semibold capitalize">{mode.name}</h4>
            {mode.enabled ? (
              <CheckCircle className="w-4 h-4 text-green-500" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-gray-400" />
            )}
          </div>
          
          <p className="text-sm text-gray-600 mb-2">{mode.description}</p>
          
          <div className="text-xs text-gray-500">
            Supports: {mode.supported_websites.slice(0, 2).join(', ')}
            {mode.supported_websites.length > 2 && '...'}
          </div>
        </div>
      </div>
    </div>
  );
};

// Mode configuration editor
const ModeConfigEditor: React.FC<{
  mode: CrawlMode;
  onUpdate: (modeName: string, config: CrawlModeConfig) => void;
  saving: boolean;
}> = ({ mode, onUpdate, saving }) => {
  const [config, setConfig] = useState<CrawlModeConfig>(mode.configuration);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setConfig(mode.configuration);
    setHasChanges(false);
  }, [mode]);

  const handleConfigChange = (field: keyof CrawlModeConfig, value: any) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleCustomSettingChange = (key: string, value: any) => {
    setConfig(prev => ({
      ...prev,
      custom_settings: { ...prev.custom_settings, [key]: value }
    }));
    setHasChanges(true);
  };

  const handleSave = () => {
    onUpdate(mode.name, config);
    setHasChanges(false);
  };

  const handleReset = () => {
    setConfig(mode.configuration);
    setHasChanges(false);
  };

  return (
    <div className="bg-white rounded-lg border p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold capitalize">
          {mode.name} Configuration
        </h3>
        
        <div className="flex gap-2">
          {hasChanges && (
            <button
              onClick={handleReset}
              className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 flex items-center gap-1"
            >
              <RotateCcw className="w-4 h-4" />
              Reset
            </button>
          )}
          
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save Changes
          </button>
        </div>
      </div>

      {/* Basic Configuration */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Status</label>
          <select
            value={config.enabled ? 'enabled' : 'disabled'}
            onChange={(e) => handleConfigChange('enabled', e.target.value === 'enabled')}
            className="w-full px-3 py-2 border rounded-md"
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Priority</label>
          <select
            value={config.priority}
            onChange={(e) => handleConfigChange('priority', e.target.value)}
            className="w-full px-3 py-2 border rounded-md"
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Max Pages</label>
          <input
            type="number"
            min="1"
            max="1000"
            value={config.max_pages}
            onChange={(e) => handleConfigChange('max_pages', parseInt(e.target.value))}
            className="w-full px-3 py-2 border rounded-md"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Max Depth</label>
          <input
            type="number"
            min="1"
            max="10"
            value={config.max_depth}
            onChange={(e) => handleConfigChange('max_depth', parseInt(e.target.value))}
            className="w-full px-3 py-2 border rounded-md"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Concurrent Requests</label>
          <input
            type="number"
            min="1"
            max="20"
            value={config.concurrent_requests}
            onChange={(e) => handleConfigChange('concurrent_requests', parseInt(e.target.value))}
            className="w-full px-3 py-2 border rounded-md"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Delay Between Requests (seconds)</label>
          <input
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            value={config.delay_between_requests}
            onChange={(e) => handleConfigChange('delay_between_requests', parseFloat(e.target.value))}
            className="w-full px-3 py-2 border rounded-md"
          />
        </div>
      </div>

      {/* Mode-specific Configuration */}
      <ModeSpecificConfig
        modeName={mode.name}
        customSettings={config.custom_settings}
        onChange={handleCustomSettingChange}
      />
    </div>
  );
};

// Mode-specific configuration sections
const ModeSpecificConfig: React.FC<{
  modeName: string;
  customSettings: Record<string, any>;
  onChange: (key: string, value: any) => void;
}> = ({ modeName, customSettings, onChange }) => {
  if (modeName === 'ecommerce') {
    return (
      <div className="border-t pt-6">
        <h4 className="font-medium mb-4">E-commerce Specific Settings</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="extract_variants"
              checked={customSettings.extract_variants || false}
              onChange={(e) => onChange('extract_variants', e.target.checked)}
            />
            <label htmlFor="extract_variants" className="text-sm">Extract Product Variants</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="extract_reviews"
              checked={customSettings.extract_reviews || false}
              onChange={(e) => onChange('extract_reviews', e.target.checked)}
            />
            <label htmlFor="extract_reviews" className="text-sm">Extract Reviews</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="track_price_changes"
              checked={customSettings.track_price_changes || false}
              onChange={(e) => onChange('track_price_changes', e.target.checked)}
            />
            <label htmlFor="track_price_changes" className="text-sm">Track Price Changes</label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Max Images per Product</label>
            <input
              type="number"
              min="1"
              max="50"
              value={customSettings.max_images_per_product || 10}
              onChange={(e) => onChange('max_images_per_product', parseInt(e.target.value))}
              className="w-full px-3 py-2 border rounded-md"
            />
          </div>
        </div>
      </div>
    );
  }

  if (modeName === 'blog') {
    return (
      <div className="border-t pt-6">
        <h4 className="font-medium mb-4">Blog Specific Settings</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="extract_author"
              checked={customSettings.extract_author || false}
              onChange={(e) => onChange('extract_author', e.target.checked)}
            />
            <label htmlFor="extract_author" className="text-sm">Extract Author Information</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="extract_tags"
              checked={customSettings.extract_tags || false}
              onChange={(e) => onChange('extract_tags', e.target.checked)}
            />
            <label htmlFor="extract_tags" className="text-sm">Extract Tags and Categories</label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Min Article Length</label>
            <input
              type="number"
              min="100"
              max="10000"
              value={customSettings.min_article_length || 300}
              onChange={(e) => onChange('min_article_length', parseInt(e.target.value))}
              className="w-full px-3 py-2 border rounded-md"
            />
          </div>
        </div>
      </div>
    );
  }

  if (modeName === 'documentation') {
    return (
      <div className="border-t pt-6">
        <h4 className="font-medium mb-4">Documentation Specific Settings</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="extract_code_examples"
              checked={customSettings.extract_code_examples || false}
              onChange={(e) => onChange('extract_code_examples', e.target.checked)}
            />
            <label htmlFor="extract_code_examples" className="text-sm">Extract Code Examples</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="extract_api_endpoints"
              checked={customSettings.extract_api_endpoints || false}
              onChange={(e) => onChange('extract_api_endpoints', e.target.checked)}
            />
            <label htmlFor="extract_api_endpoints" className="text-sm">Extract API Endpoints</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="follow_internal_links"
              checked={customSettings.follow_internal_links || false}
              onChange={(e) => onChange('follow_internal_links', e.target.checked)}
            />
            <label htmlFor="follow_internal_links" className="text-sm">Follow Internal Links</label>
          </div>
        </div>
      </div>
    );
  }

  return null;
};