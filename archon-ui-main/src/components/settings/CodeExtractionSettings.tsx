import React, { useState } from 'react';
import { Code, Check, Save, Loader } from 'lucide-react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useToast } from '../../features/shared/hooks/useToast';
import { credentialsService } from '../../services/credentialsService';

interface CodeExtractionSettingsProps {
  codeExtractionSettings: {
    MIN_CODE_BLOCK_LENGTH: number;
    MAX_CODE_BLOCK_LENGTH: number;
    ENABLE_COMPLETE_BLOCK_DETECTION: boolean;
    ENABLE_LANGUAGE_SPECIFIC_PATTERNS: boolean;
    ENABLE_PROSE_FILTERING: boolean;
    MAX_PROSE_RATIO: number;
    MIN_CODE_INDICATORS: number;
    ENABLE_DIAGRAM_FILTERING: boolean;
    ENABLE_CONTEXTUAL_LENGTH: boolean;
    CODE_EXTRACTION_MAX_WORKERS: number;
    CONTEXT_WINDOW_SIZE: number;
    ENABLE_CODE_SUMMARIES: boolean;
  };
  setCodeExtractionSettings: (settings: any) => void;
}

export const CodeExtractionSettings = ({
  codeExtractionSettings,
  setCodeExtractionSettings
}: CodeExtractionSettingsProps) => {
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const handleSave = async () => {
    try {
      setSaving(true);
      await credentialsService.updateCodeExtractionSettings(codeExtractionSettings);
      showToast('Code extraction settings saved successfully!', 'success');
    } catch (err) {
      console.error('Failed to save code extraction settings:', err);
      showToast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
      <Card accentColor="orange" className="overflow-hidden p-8">
        {/* Description */}
        <p className="text-sm text-gray-600 dark:text-zinc-400 mb-6">
          Configure how code blocks are extracted from crawled documents.
        </p>

        {/* Save button row */}
        <div className="flex justify-end mb-6">
          <Button 
            variant="outline" 
            accentColor="orange" 
            icon={saving ? <Loader className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            className="whitespace-nowrap"
            size="md"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>

        {/* Length Settings */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Code Block Length
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Minimum Length (chars)"
              type="number"
              value={codeExtractionSettings.MIN_CODE_BLOCK_LENGTH}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                MIN_CODE_BLOCK_LENGTH: parseInt(e.target.value, 10) || 250
              })}
              placeholder="250"
              accentColor="orange"
              min="50"
              max="2000"
            />
            <Input
              label="Maximum Length (chars)"
              type="number"
              value={codeExtractionSettings.MAX_CODE_BLOCK_LENGTH}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                MAX_CODE_BLOCK_LENGTH: parseInt(e.target.value, 10) || 5000
              })}
              placeholder="5000"
              accentColor="orange"
              min="1000"
              max="20000"
            />
          </div>
        </div>

        {/* Detection Features */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Detection Features
          </h3>
          <div className="space-y-3">
            <CustomCheckbox
              id="completeBlockDetection"
              checked={codeExtractionSettings.ENABLE_COMPLETE_BLOCK_DETECTION}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                ENABLE_COMPLETE_BLOCK_DETECTION: e.target.checked
              })}
              label="Complete Block Detection"
              description="Extend code blocks to natural boundaries (closing braces, etc.)"
            />
            <CustomCheckbox
              id="languagePatterns"
              checked={codeExtractionSettings.ENABLE_LANGUAGE_SPECIFIC_PATTERNS}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                ENABLE_LANGUAGE_SPECIFIC_PATTERNS: e.target.checked
              })}
              label="Language-Specific Patterns"
              description="Use specialized patterns for TypeScript, Python, Java, etc."
            />
            <CustomCheckbox
              id="contextualLength"
              checked={codeExtractionSettings.ENABLE_CONTEXTUAL_LENGTH}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                ENABLE_CONTEXTUAL_LENGTH: e.target.checked
              })}
              label="Contextual Length Adjustment"
              description="Adjust minimum length based on context (example, snippet, implementation)"
            />
          </div>
        </div>

        {/* Filtering Settings */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Content Filtering
          </h3>
          <div className="space-y-3">
            <CustomCheckbox
              id="proseFiltering"
              checked={codeExtractionSettings.ENABLE_PROSE_FILTERING}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                ENABLE_PROSE_FILTERING: e.target.checked
              })}
              label="Filter Prose Content"
              description="Remove documentation text mistakenly wrapped in code blocks"
            />
            <CustomCheckbox
              id="diagramFiltering"
              checked={codeExtractionSettings.ENABLE_DIAGRAM_FILTERING}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                ENABLE_DIAGRAM_FILTERING: e.target.checked
              })}
              label="Filter Diagram Languages"
              description="Exclude Mermaid, PlantUML, and other diagram formats"
            />
            <CustomCheckbox
              id="codeSummaries"
              checked={codeExtractionSettings.ENABLE_CODE_SUMMARIES}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                ENABLE_CODE_SUMMARIES: e.target.checked
              })}
              label="Generate Code Summaries"
              description="Use AI to create summaries and names for code examples"
            />
          </div>
        </div>

        {/* Advanced Settings */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Advanced Settings
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Max Prose Ratio"
              type="number"
              value={codeExtractionSettings.MAX_PROSE_RATIO}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                MAX_PROSE_RATIO: parseFloat(e.target.value) || 0.15
              })}
              placeholder="0.15"
              accentColor="orange"
              min="0"
              max="1"
              step="0.05"
            />
            <Input
              label="Min Code Indicators"
              type="number"
              value={codeExtractionSettings.MIN_CODE_INDICATORS}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                MIN_CODE_INDICATORS: parseInt(e.target.value, 10) || 3
              })}
              placeholder="3"
              accentColor="orange"
              min="1"
              max="10"
            />
            <Input
              label="Context Window Size"
              type="number"
              value={codeExtractionSettings.CONTEXT_WINDOW_SIZE}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                CONTEXT_WINDOW_SIZE: parseInt(e.target.value, 10) || 1000
              })}
              placeholder="1000"
              accentColor="orange"
              min="100"
              max="5000"
            />
            <Input
              label="Max Workers"
              type="number"
              value={codeExtractionSettings.CODE_EXTRACTION_MAX_WORKERS}
              onChange={e => setCodeExtractionSettings({
                ...codeExtractionSettings,
                CODE_EXTRACTION_MAX_WORKERS: parseInt(e.target.value, 10) || 3
              })}
              placeholder="3"
              accentColor="orange"
              min="1"
              max="10"
            />
          </div>
        </div>

        {/* Info boxes for the advanced settings */}
        <div className="grid grid-cols-2 gap-4 text-xs text-gray-600 dark:text-gray-400">
          <div>
            <p><strong>Max Prose Ratio:</strong> Maximum percentage of prose indicators allowed (0-1)</p>
            <p className="mt-1"><strong>Context Window:</strong> Characters of context before/after code blocks</p>
          </div>
          <div>
            <p><strong>Min Code Indicators:</strong> Required code patterns (brackets, operators, keywords)</p>
            <p className="mt-1"><strong>Max Workers:</strong> Parallel processing for code summaries</p>
          </div>
        </div>
      </Card>
  );
};

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
            peer-checked:border-purple-500 dark:peer-checked:border-purple-500/50
            peer-checked:bg-gradient-to-b peer-checked:from-purple-500/20 peer-checked:to-purple-600/20
            group-hover:border-purple-500/50 dark:group-hover:border-purple-500/30
            peer-checked:shadow-[0_0_10px_rgba(168,85,247,0.2)] dark:peer-checked:shadow-[0_0_15px_rgba(168,85,247,0.3)]"
        >
          <Check className={`
              w-3.5 h-3.5 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
              transition-all duration-200 text-purple-500 pointer-events-none
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