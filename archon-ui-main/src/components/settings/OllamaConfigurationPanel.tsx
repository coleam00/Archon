import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { useToast } from '../../features/ui/hooks/useToast';
import { cn } from '../../lib/utils';
import { credentialsService, OllamaInstance } from '../../services/credentialsService';
import { OllamaModelDiscoveryModal } from './OllamaModelDiscoveryModal';
import type { OllamaInstance as OllamaInstanceType } from './types/OllamaTypes';

interface OllamaConfigurationPanelProps {
  isVisible: boolean;
  onConfigChange: (instances: OllamaInstance[]) => void;
  className?: string;
  separateHosts?: boolean; // Enable separate LLM Chat and Embedding host configuration
}

interface ConnectionTestResult {
  isHealthy: boolean;
  responseTimeMs?: number;
  modelsAvailable?: number;
  error?: string;
}

const OllamaConfigurationPanel: React.FC<OllamaConfigurationPanelProps> = ({
  isVisible,
  onConfigChange,
  className = '',
  separateHosts = false
}) => {
  const [instances, setInstances] = useState<OllamaInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingConnections, setTestingConnections] = useState<Set<string>>(new Set());
  const [newInstanceUrl, setNewInstanceUrl] = useState('');
  const [newInstanceName, setNewInstanceName] = useState('');
  const [newInstanceType, setNewInstanceType] = useState<'chat' | 'embedding'>('chat');
  const [showAddInstance, setShowAddInstance] = useState(false);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [modelDiscoveryResults, setModelDiscoveryResults] = useState<any>(null);
  const [showModelDiscoveryModal, setShowModelDiscoveryModal] = useState(false);
  const [selectedChatModel, setSelectedChatModel] = useState<string | null>(null);
  const [selectedEmbeddingModel, setSelectedEmbeddingModel] = useState<string | null>(null);
  // Track temporary URL values for each instance to prevent aggressive updates
  const [tempUrls, setTempUrls] = useState<Record<string, string>>({});
  const updateTimeouts = useRef<Record<string, NodeJS.Timeout>>({});
  const { showToast } = useToast();

  // Load instances from database
  const loadInstances = async () => {
    try {
      setLoading(true);
      
      // First try to migrate from localStorage if needed
      const migrationResult = await credentialsService.migrateOllamaFromLocalStorage();
      if (migrationResult.migrated) {
        showToast(`Migrated ${migrationResult.instanceCount} Ollama instances to database`, 'success');
      }
      
      // Load instances from database
      const databaseInstances = await credentialsService.getOllamaInstances();
      setInstances(databaseInstances);
      onConfigChange(databaseInstances);
    } catch (error) {
      console.error('Failed to load Ollama instances from database:', error);
      showToast('Failed to load Ollama configuration from database', 'error');
      
      // Fallback to localStorage
      try {
        const saved = localStorage.getItem('ollama-instances');
        if (saved) {
          const localInstances = JSON.parse(saved);
          setInstances(localInstances);
          onConfigChange(localInstances);
          showToast('Loaded Ollama configuration from local backup', 'warning');
        }
      } catch (localError) {
        console.error('Failed to load from localStorage as fallback:', localError);
      }
    } finally {
      setLoading(false);
    }
  };

  // Save instances to database
  const saveInstances = async (newInstances: OllamaInstance[]) => {
    try {
      setLoading(true);
      await credentialsService.setOllamaInstances(newInstances);
      setInstances(newInstances);
      onConfigChange(newInstances);
      
      // Also backup to localStorage for fallback
      try {
        localStorage.setItem('ollama-instances', JSON.stringify(newInstances));
      } catch (localError) {
        console.warn('Failed to backup to localStorage:', localError);
      }
    } catch (error) {
      console.error('Failed to save Ollama instances to database:', error);
      showToast('Failed to save Ollama configuration to database', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Test connection to an Ollama instance with retry logic
  const testConnection = async (baseUrl: string, retryCount = 3): Promise<ConnectionTestResult> => {
    const maxRetries = retryCount;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch('/api/providers/validate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'ollama',
            base_url: baseUrl
          })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        
        const result = {
          isHealthy: data.health_status?.is_available || false,
          responseTimeMs: data.health_status?.response_time_ms,
          modelsAvailable: data.health_status?.models_available,
          error: data.health_status?.error_message
        };

        // If successful, return immediately
        if (result.isHealthy) {
          return result;
        }

        // If not healthy but we got a valid response, still return (but might retry)
        lastError = new Error(result.error || 'Instance not available');
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
      }

      // If this wasn't the last attempt, wait before retrying
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // All retries failed, return error result
    return {
      isHealthy: false,
      error: lastError?.message || 'Connection failed after retries'
    };
  };

  // Handle connection test for a specific instance
  const handleTestConnection = async (instanceId: string) => {
    const instance = instances.find(inst => inst.id === instanceId);
    if (!instance) return;

    setTestingConnections(prev => new Set(prev).add(instanceId));

    try {
      const result = await testConnection(instance.baseUrl);
      
      // Update instance with test results
      const updatedInstances = instances.map(inst => 
        inst.id === instanceId 
          ? {
              ...inst,
              isHealthy: result.isHealthy,
              responseTimeMs: result.responseTimeMs,
              modelsAvailable: result.modelsAvailable,
              lastHealthCheck: new Date().toISOString()
            }
          : inst
      );
      saveInstances(updatedInstances);

      if (result.isHealthy) {
        showToast(`Connected to ${instance.name} (${result.responseTimeMs?.toFixed(0)}ms, ${result.modelsAvailable} models)`, 'success');
      } else {
        showToast(result.error || 'Unable to connect to Ollama instance', 'error');
      }
    } catch (error) {
      showToast(`Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setTestingConnections(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  // Add new instance
  const handleAddInstance = async () => {
    if (!newInstanceUrl.trim() || !newInstanceName.trim()) {
      showToast('Please provide both URL and name for the new instance', 'error');
      return;
    }

    // Validate URL format
    try {
      const url = new URL(newInstanceUrl);
      if (!url.protocol.startsWith('http')) {
        throw new Error('URL must use HTTP or HTTPS protocol');
      }
    } catch (error) {
      showToast('Please provide a valid HTTP/HTTPS URL', 'error');
      return;
    }

    // Check for duplicate URLs
    const isDuplicate = instances.some(inst => inst.baseUrl === newInstanceUrl.trim());
    if (isDuplicate) {
      showToast('An instance with this URL already exists', 'error');
      return;
    }

    const newInstance: OllamaInstance = {
      id: `instance-${Date.now()}`,
      name: newInstanceName.trim(),
      baseUrl: newInstanceUrl.trim(),
      isEnabled: true,
      isPrimary: false,
      loadBalancingWeight: 100,
      instanceType: separateHosts ? newInstanceType : 'both'
    };

    try {
      setLoading(true);
      await credentialsService.addOllamaInstance(newInstance);
      
      // Reload instances from database to get updated list
      await loadInstances();
      
      setNewInstanceUrl('');
      setNewInstanceName('');
      setNewInstanceType('chat');
      setShowAddInstance(false);
      
      showToast(`Added new Ollama instance: ${newInstance.name}`, 'success');
    } catch (error) {
      console.error('Failed to add Ollama instance:', error);
      showToast(`Failed to add Ollama instance: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Remove instance
  const handleRemoveInstance = async (instanceId: string) => {
    const instance = instances.find(inst => inst.id === instanceId);
    if (!instance) return;

    // Don't allow removing the last instance
    if (instances.length <= 1) {
      showToast('At least one Ollama instance must be configured', 'error');
      return;
    }

    try {
      setLoading(true);
      await credentialsService.removeOllamaInstance(instanceId);
      
      // Reload instances from database to get updated list
      await loadInstances();
      
      showToast(`Removed Ollama instance: ${instance.name}`, 'success');
    } catch (error) {
      console.error('Failed to remove Ollama instance:', error);
      showToast(`Failed to remove Ollama instance: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Debounced URL update - only update after user stops typing for 1 second
  const debouncedUpdateInstanceUrl = useCallback(async (instanceId: string, newUrl: string) => {
    try {
      // Clear any existing timeout for this instance
      if (updateTimeouts.current[instanceId]) {
        clearTimeout(updateTimeouts.current[instanceId]);
      }

      // Set new timeout
      updateTimeouts.current[instanceId] = setTimeout(async () => {
        try {
          await credentialsService.updateOllamaInstance(instanceId, { 
            baseUrl: newUrl, 
            isHealthy: undefined, 
            lastHealthCheck: undefined 
          });
          await loadInstances(); // Reload to get updated data
          // Clear the temporary URL after successful update
          setTempUrls(prev => {
            const updated = { ...prev };
            delete updated[instanceId];
            return updated;
          });
          // Connection test removed - only manual testing via "Test" button per user request
        } catch (error) {
          console.error('Failed to update Ollama instance URL:', error);
          showToast('Failed to update instance URL', 'error');
        }
      }, 1000); // 1 second debounce
    } catch (error) {
      console.error('Failed to set up URL update timeout:', error);
    }
  }, [showToast]);

  // Handle immediate URL change (for UI responsiveness) without triggering API calls
  const handleUrlChange = (instanceId: string, newUrl: string) => {
    // Update temporary URL state for immediate UI feedback
    setTempUrls(prev => ({ ...prev, [instanceId]: newUrl }));
    // Trigger debounced update
    debouncedUpdateInstanceUrl(instanceId, newUrl);
  };

  // Handle URL blur - immediately save if there are pending changes
  const handleUrlBlur = async (instanceId: string) => {
    const tempUrl = tempUrls[instanceId];
    const instance = instances.find(inst => inst.id === instanceId);
    
    if (tempUrl && instance && tempUrl !== instance.baseUrl) {
      // Clear the timeout since we're updating immediately
      if (updateTimeouts.current[instanceId]) {
        clearTimeout(updateTimeouts.current[instanceId]);
        delete updateTimeouts.current[instanceId];
      }

      try {
        await credentialsService.updateOllamaInstance(instanceId, { 
          baseUrl: tempUrl, 
          isHealthy: undefined, 
          lastHealthCheck: undefined 
        });
        await loadInstances();
        // Clear the temporary URL after successful update
        setTempUrls(prev => {
          const updated = { ...prev };
          delete updated[instanceId];
          return updated;
        });
        // Connection test removed - only manual testing via "Test" button per user request
      } catch (error) {
        console.error('Failed to update Ollama instance URL:', error);
        showToast('Failed to update instance URL', 'error');
      }
    }
  };

  // Toggle instance enabled state
  const handleToggleInstance = async (instanceId: string) => {
    const instance = instances.find(inst => inst.id === instanceId);
    if (!instance) return;

    try {
      await credentialsService.updateOllamaInstance(instanceId, { 
        isEnabled: !instance.isEnabled 
      });
      await loadInstances(); // Reload to get updated data
    } catch (error) {
      console.error('Failed to toggle Ollama instance:', error);
      showToast('Failed to toggle instance state', 'error');
    }
  };

  // Set instance as primary
  const handleSetPrimary = async (instanceId: string) => {
    try {
      // Update all instances - only the specified one should be primary
      await saveInstances(instances.map(inst => ({
        ...inst,
        isPrimary: inst.id === instanceId
      })));
    } catch (error) {
      console.error('Failed to set primary Ollama instance:', error);
      showToast('Failed to set primary instance', 'error');
    }
  };

  // Open model discovery modal
  const handleDiscoverModels = () => {
    if (instances.length === 0) {
      showToast('No Ollama instances configured', 'error');
      return;
    }

    const enabledInstances = instances.filter(inst => inst.isEnabled);
    if (enabledInstances.length === 0) {
      showToast('No enabled Ollama instances found', 'error');
      return;
    }

    setShowModelDiscoveryModal(true);
  };

  // Handle model selection from discovery modal
  const handleModelSelection = async (models: { chatModel?: string; embeddingModel?: string }) => {
    try {
      setSelectedChatModel(models.chatModel || null);
      setSelectedEmbeddingModel(models.embeddingModel || null);
      
      // Store model preferences in localStorage for persistence
      const modelPreferences = {
        chatModel: models.chatModel,
        embeddingModel: models.embeddingModel,
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem('ollama-selected-models', JSON.stringify(modelPreferences));
      
      let successMessage = 'Model selection updated';
      if (models.chatModel && models.embeddingModel) {
        successMessage = `Selected models: ${models.chatModel} (chat), ${models.embeddingModel} (embedding)`;
      } else if (models.chatModel) {
        successMessage = `Selected chat model: ${models.chatModel}`;
      } else if (models.embeddingModel) {
        successMessage = `Selected embedding model: ${models.embeddingModel}`;
      }
      
      showToast(successMessage, 'success');
      setShowModelDiscoveryModal(false);
    } catch (error) {
      console.error('Failed to save model selection:', error);
      showToast('Failed to save model selection', 'error');
    }
  };

  // Load instances from database on mount
  useEffect(() => {
    loadInstances();
  }, []); // Empty dependency array - load only on mount

  // Load saved model preferences on mount
  useEffect(() => {
    try {
      const savedPreferences = localStorage.getItem('ollama-selected-models');
      if (savedPreferences) {
        const preferences = JSON.parse(savedPreferences);
        setSelectedChatModel(preferences.chatModel || null);
        setSelectedEmbeddingModel(preferences.embeddingModel || null);
      }
    } catch (error) {
      console.warn('Failed to load saved model preferences:', error);
    }
  }, []);

  // Notify parent of configuration changes
  useEffect(() => {
    onConfigChange(instances);
  }, [instances, onConfigChange]);

  // Note: Auto-testing completely removed to prevent API calls on every keystroke
  // Connection testing now ONLY happens on manual "Test Connection" button clicks
  // No automatic testing on URL changes, saves, or blur events per user request

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      // Clear all pending timeouts
      Object.values(updateTimeouts.current).forEach(timeout => {
        if (timeout) clearTimeout(timeout);
      });
      updateTimeouts.current = {};
    };
  }, []);

  if (!isVisible) return null;

  const getConnectionStatusBadge = (instance: OllamaInstance) => {
    if (testingConnections.has(instance.id)) {
      return <Badge variant="outline" color="gray" className="animate-pulse">Testing...</Badge>;
    }
    
    if (instance.isHealthy === true) {
      return (
        <Badge variant="solid" color="green" className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          Online
          {instance.responseTimeMs && (
            <span className="text-xs opacity-75">
              ({instance.responseTimeMs.toFixed(0)}ms)
            </span>
          )}
        </Badge>
      );
    }
    
    if (instance.isHealthy === false) {
      return (
        <Badge variant="solid" color="pink" className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-red-500" />
          Offline
        </Badge>
      );
    }
    
    // For instances that haven't been tested yet (isHealthy === undefined)
    // Show a "checking" status until manually tested via "Test" button
    return (
      <Badge variant="outline" color="blue" className="animate-pulse">
        <div className="w-2 h-2 rounded-full bg-blue-500 animate-ping mr-1" />
        Checking...
      </Badge>
    );
  };

  return (
    <Card 
      accentColor="green" 
      className={cn("mt-4 space-y-4", className)}
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Ollama Configuration
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Configure Ollama instances for distributed processing
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleDiscoverModels}
            disabled={instances.filter(inst => inst.isEnabled).length === 0}
            className="text-xs"
          >
            {selectedChatModel || selectedEmbeddingModel ? 'Change Models' : 'Select Models'}
          </Button>
          <Badge variant="outline" color="gray" className="text-xs">
            {instances.filter(inst => inst.isEnabled).length} Active
          </Badge>
          {(selectedChatModel || selectedEmbeddingModel) && (
            <div className="flex gap-1">
              {selectedChatModel && (
                <Badge variant="solid" color="blue" className="text-xs">
                  Chat: {selectedChatModel.split(':')[0]}
                </Badge>
              )}
              {selectedEmbeddingModel && (
                <Badge variant="solid" color="purple" className="text-xs">
                  Embed: {selectedEmbeddingModel.split(':')[0]}
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Instance List */}
      <div className="space-y-3">
        {instances.map((instance) => (
          <Card key={instance.id} className="p-4 bg-gray-50 dark:bg-gray-800/50">
            <div className="flex items-start justify-between">
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900 dark:text-white">
                    {instance.name}
                  </span>
                  {instance.isPrimary && (
                    <Badge variant="outline" color="gray" className="text-xs">Primary</Badge>
                  )}
                  {instance.instanceType && instance.instanceType !== 'both' && (
                    <Badge 
                      variant="solid" 
                      color={instance.instanceType === 'chat' ? 'blue' : 'purple'}
                      className="text-xs"
                    >
                      {instance.instanceType === 'chat' ? 'Chat' : 'Embedding'}
                    </Badge>
                  )}
                  {(!instance.instanceType || instance.instanceType === 'both') && separateHosts && (
                    <Badge variant="outline" color="gray" className="text-xs">
                      Both
                    </Badge>
                  )}
                  {getConnectionStatusBadge(instance)}
                </div>
                
                <div className="relative">
                  <Input
                    type="url"
                    value={tempUrls[instance.id] !== undefined ? tempUrls[instance.id] : instance.baseUrl}
                    onChange={(e) => handleUrlChange(instance.id, e.target.value)}
                    onBlur={() => handleUrlBlur(instance.id)}
                    placeholder="http://host.docker.internal:11434"
                    className={cn(
                      "text-sm",
                      tempUrls[instance.id] !== undefined && tempUrls[instance.id] !== instance.baseUrl 
                        ? "border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20" 
                        : ""
                    )}
                  />
                  {tempUrls[instance.id] !== undefined && tempUrls[instance.id] !== instance.baseUrl && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" title="Changes will be saved after you stop typing" />
                    </div>
                  )}
                </div>
                
                {instance.modelsAvailable !== undefined && (
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    {instance.modelsAvailable} models available
                  </div>
                )}
              </div>
              
              <div className="flex items-center gap-2 ml-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleTestConnection(instance.id)}
                  disabled={testingConnections.has(instance.id)}
                  className="text-xs"
                >
                  {testingConnections.has(instance.id) ? 'Testing...' : 'Test'}
                </Button>
                
                {!instance.isPrimary && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSetPrimary(instance.id)}
                    className="text-xs"
                  >
                    Set Primary
                  </Button>
                )}
                
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleInstance(instance.id)}
                  className={cn(
                    "text-xs",
                    instance.isEnabled 
                      ? "text-green-600 hover:text-green-700" 
                      : "text-gray-500 hover:text-gray-600"
                  )}
                >
                  {instance.isEnabled ? 'Enabled' : 'Disabled'}
                </Button>
                
                {instances.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveInstance(instance.id)}
                    className="text-xs text-red-600 hover:text-red-700"
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Add Instance Section */}
      {showAddInstance ? (
        <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
          <div className="space-y-3">
            <h4 className="font-medium text-blue-900 dark:text-blue-100">
              Add New Ollama Instance
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                type="text"
                placeholder="Instance Name"
                value={newInstanceName}
                onChange={(e) => setNewInstanceName(e.target.value)}
              />
              <Input
                type="url"
                placeholder="http://host.docker.internal:11434"
                value={newInstanceUrl}
                onChange={(e) => setNewInstanceUrl(e.target.value)}
              />
            </div>
            
            {separateHosts && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-blue-900 dark:text-blue-100">
                  Instance Type
                </label>
                <div className="flex gap-2">
                  <Button
                    variant={newInstanceType === 'chat' ? 'solid' : 'outline'}
                    size="sm"
                    onClick={() => setNewInstanceType('chat')}
                    className={cn(
                      newInstanceType === 'chat' 
                        ? 'bg-blue-600 text-white' 
                        : 'text-blue-600 border-blue-600'
                    )}
                  >
                    LLM Chat
                  </Button>
                  <Button
                    variant={newInstanceType === 'embedding' ? 'solid' : 'outline'}
                    size="sm"
                    onClick={() => setNewInstanceType('embedding')}
                    className={cn(
                      newInstanceType === 'embedding' 
                        ? 'bg-blue-600 text-white' 
                        : 'text-blue-600 border-blue-600'
                    )}
                  >
                    Embedding
                  </Button>
                </div>
              </div>
            )}
            
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleAddInstance}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Add Instance
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowAddInstance(false);
                  setNewInstanceUrl('');
                  setNewInstanceName('');
                  setNewInstanceType('chat');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Button
          variant="outline"
          onClick={() => setShowAddInstance(true)}
          className="w-full border-dashed border-2 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
        >
          <span className="text-gray-600 dark:text-gray-400">+ Add Ollama Instance</span>
        </Button>
      )}

      {/* Selected Models Summary for Dual-Host Mode */}
      {separateHosts && (selectedChatModel || selectedEmbeddingModel) && (
        <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
          <h4 className="font-medium text-blue-900 dark:text-blue-100 mb-3">
            Model Assignment Summary
          </h4>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {selectedChatModel && (
              <div className="flex items-center justify-between p-3 bg-blue-100 dark:bg-blue-800/30 rounded">
                <div>
                  <div className="font-medium text-blue-900 dark:text-blue-100">
                    Chat Model
                  </div>
                  <div className="text-sm text-blue-700 dark:text-blue-300">
                    {selectedChatModel}
                  </div>
                </div>
                <Badge variant="solid" color="blue">
                  {instances.filter(inst => inst.instanceType === 'chat' || inst.instanceType === 'both').length} hosts
                </Badge>
              </div>
            )}
            
            {selectedEmbeddingModel && (
              <div className="flex items-center justify-between p-3 bg-purple-100 dark:bg-purple-800/30 rounded">
                <div>
                  <div className="font-medium text-purple-900 dark:text-purple-100">
                    Embedding Model
                  </div>
                  <div className="text-sm text-purple-700 dark:text-purple-300">
                    {selectedEmbeddingModel}
                  </div>
                </div>
                <Badge variant="solid" color="purple">
                  {instances.filter(inst => inst.instanceType === 'embedding' || inst.instanceType === 'both').length} hosts
                </Badge>
              </div>
            )}
          </div>
          
          {(!selectedChatModel || !selectedEmbeddingModel) && (
            <div className="mt-3 text-xs text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/30 p-2 rounded">
              <strong>Tip:</strong> {!selectedChatModel && !selectedEmbeddingModel ? 'Select both chat and embedding models for optimal performance' : !selectedChatModel ? 'Consider selecting a chat model for LLM operations' : 'Consider selecting an embedding model for vector operations'}
            </div>
          )}
        </Card>
      )}

      {/* Configuration Summary */}
      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
          <div className="flex justify-between">
            <span>Total Instances:</span>
            <span className="font-mono">{instances.length}</span>
          </div>
          <div className="flex justify-between">
            <span>Active Instances:</span>
            <span className="font-mono text-green-600 dark:text-green-400">
              {instances.filter(inst => inst.isEnabled && inst.isHealthy).length}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Load Balancing:</span>
            <span className="font-mono">
              {instances.filter(inst => inst.isEnabled).length > 1 ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          {(selectedChatModel || selectedEmbeddingModel) && (
            <div className="flex justify-between">
              <span>Selected Models:</span>
              <span className="font-mono text-green-600 dark:text-green-400">
                {[selectedChatModel, selectedEmbeddingModel].filter(Boolean).length}
              </span>
            </div>
          )}
          {separateHosts && (
            <div className="flex justify-between">
              <span>Dual-Host Mode:</span>
              <span className="font-mono text-blue-600 dark:text-blue-400">
                Enabled
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Model Discovery Modal */}
      <OllamaModelDiscoveryModal
        isOpen={showModelDiscoveryModal}
        onClose={() => setShowModelDiscoveryModal(false)}
        onSelectModels={handleModelSelection}
        instances={instances.filter(inst => inst.isEnabled).map(inst => ({
          id: inst.id,
          name: inst.name,
          baseUrl: inst.baseUrl,
          instanceType: inst.instanceType || 'both',
          isEnabled: inst.isEnabled,
          isPrimary: inst.isPrimary,
          healthStatus: {
            isHealthy: inst.isHealthy || false,
            lastChecked: inst.lastHealthCheck ? new Date(inst.lastHealthCheck) : new Date(),
            responseTimeMs: inst.responseTimeMs,
            error: inst.isHealthy === false ? 'Connection failed' : undefined
          },
          loadBalancingWeight: inst.loadBalancingWeight,
          lastHealthCheck: inst.lastHealthCheck,
          modelsAvailable: inst.modelsAvailable,
          responseTimeMs: inst.responseTimeMs
        }))}
      />
    </Card>
  );
};

export default OllamaConfigurationPanel;