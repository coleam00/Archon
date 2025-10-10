import React, { useState } from 'react';
import { Code, Check, Save, Loader } from 'lucide-react';
import { Card } from '@/features/ui/primitives/card';
import { Input, Label, FormField, FormGrid } from '@/features/ui/primitives/input';
import { Button } from '@/features/ui/primitives/button';
import { Checkbox } from '@/features/ui/primitives/checkbox';
import { useToast } from '../../shared/hooks/useToast';
import { credentialsService } from '../../../services/credentialsService';

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
      <Card edgePosition="top" edgeColor="orange">
        <p className="text-sm text-gray-600 dark:text-zinc-400 mb-6">
          Configure how code blocks are extracted from crawled documents.
        </p>

        <div className="flex justify-end mb-6">
          <Button
            variant="outline"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? <Loader className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>

        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Code Block Length
          </h3>
          <FormGrid columns={2}>
            <FormField>
              <Label htmlFor="minCodeLength">Minimum Length (chars)</Label>
              <Input
                id="minCodeLength"
                type="number"
                value={codeExtractionSettings.MIN_CODE_BLOCK_LENGTH}
                onChange={e => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  MIN_CODE_BLOCK_LENGTH: parseInt(e.target.value, 10) || 250
                })}
                placeholder="250"
                min="50"
                max="2000"
              />
            </FormField>
            <FormField>
              <Label htmlFor="maxCodeLength">Maximum Length (chars)</Label>
              <Input
                id="maxCodeLength"
                type="number"
                value={codeExtractionSettings.MAX_CODE_BLOCK_LENGTH}
                onChange={e => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  MAX_CODE_BLOCK_LENGTH: parseInt(e.target.value, 10) || 5000
                })}
                placeholder="5000"
                min="1000"
                max="20000"
              />
            </FormField>
          </FormGrid>
        </div>

        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Detection Features
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="completeBlockDetection"
                checked={codeExtractionSettings.ENABLE_COMPLETE_BLOCK_DETECTION}
                onCheckedChange={(checked) => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  ENABLE_COMPLETE_BLOCK_DETECTION: checked as boolean
                })}
                color="orange"
              />
              <div className="flex-1">
                <Label htmlFor="completeBlockDetection" className="cursor-pointer">
                  Complete Block Detection
                </Label>
                <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
                  Extend code blocks to natural boundaries (closing braces, etc.)
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="languagePatterns"
                checked={codeExtractionSettings.ENABLE_LANGUAGE_SPECIFIC_PATTERNS}
                onCheckedChange={(checked) => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  ENABLE_LANGUAGE_SPECIFIC_PATTERNS: checked as boolean
                })}
                color="orange"
              />
              <div className="flex-1">
                <Label htmlFor="languagePatterns" className="cursor-pointer">
                  Language-Specific Patterns
                </Label>
                <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
                  Use specialized patterns for TypeScript, Python, Java, etc.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="contextualLength"
                checked={codeExtractionSettings.ENABLE_CONTEXTUAL_LENGTH}
                onCheckedChange={(checked) => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  ENABLE_CONTEXTUAL_LENGTH: checked as boolean
                })}
                color="orange"
              />
              <div className="flex-1">
                <Label htmlFor="contextualLength" className="cursor-pointer">
                  Contextual Length Adjustment
                </Label>
                <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
                  Adjust minimum length based on context (example, snippet, implementation)
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Content Filtering
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="proseFiltering"
                checked={codeExtractionSettings.ENABLE_PROSE_FILTERING}
                onCheckedChange={(checked) => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  ENABLE_PROSE_FILTERING: checked as boolean
                })}
                color="orange"
              />
              <div className="flex-1">
                <Label htmlFor="proseFiltering" className="cursor-pointer">
                  Filter Prose Content
                </Label>
                <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
                  Remove documentation text mistakenly wrapped in code blocks
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="diagramFiltering"
                checked={codeExtractionSettings.ENABLE_DIAGRAM_FILTERING}
                onCheckedChange={(checked) => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  ENABLE_DIAGRAM_FILTERING: checked as boolean
                })}
                color="orange"
              />
              <div className="flex-1">
                <Label htmlFor="diagramFiltering" className="cursor-pointer">
                  Filter Diagram Languages
                </Label>
                <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
                  Exclude Mermaid, PlantUML, and other diagram formats
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="codeSummaries"
                checked={codeExtractionSettings.ENABLE_CODE_SUMMARIES}
                onCheckedChange={(checked) => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  ENABLE_CODE_SUMMARIES: checked as boolean
                })}
                color="orange"
              />
              <div className="flex-1">
                <Label htmlFor="codeSummaries" className="cursor-pointer">
                  Generate Code Summaries
                </Label>
                <p className="text-xs text-gray-600 dark:text-zinc-400 leading-tight">
                  Use AI to create summaries and names for code examples
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Advanced Settings
          </h3>
          <FormGrid columns={2}>
            <FormField>
              <Label htmlFor="maxProseRatio">Max Prose Ratio</Label>
              <Input
                id="maxProseRatio"
                type="number"
                value={codeExtractionSettings.MAX_PROSE_RATIO}
                onChange={e => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  MAX_PROSE_RATIO: parseFloat(e.target.value) || 0.15
                })}
                placeholder="0.15"
                min="0"
                max="1"
                step="0.05"
              />
            </FormField>

            <FormField>
              <Label htmlFor="minCodeIndicators">Min Code Indicators</Label>
              <Input
                id="minCodeIndicators"
                type="number"
                value={codeExtractionSettings.MIN_CODE_INDICATORS}
                onChange={e => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  MIN_CODE_INDICATORS: parseInt(e.target.value, 10) || 3
                })}
                placeholder="3"
                min="1"
                max="10"
              />
            </FormField>

            <FormField>
              <Label htmlFor="contextWindowSize">Context Window Size</Label>
              <Input
                id="contextWindowSize"
                type="number"
                value={codeExtractionSettings.CONTEXT_WINDOW_SIZE}
                onChange={e => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  CONTEXT_WINDOW_SIZE: parseInt(e.target.value, 10) || 1000
                })}
                placeholder="1000"
                min="100"
                max="5000"
              />
            </FormField>

            <FormField>
              <Label htmlFor="maxWorkers">Max Workers</Label>
              <Input
                id="maxWorkers"
                type="number"
                value={codeExtractionSettings.CODE_EXTRACTION_MAX_WORKERS}
                onChange={e => setCodeExtractionSettings({
                  ...codeExtractionSettings,
                  CODE_EXTRACTION_MAX_WORKERS: parseInt(e.target.value, 10) || 3
                })}
                placeholder="3"
                min="1"
                max="10"
              />
            </FormField>
          </FormGrid>
        </div>

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
