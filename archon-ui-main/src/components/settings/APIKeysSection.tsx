import { useState, useEffect } from 'react';
import { Key, Plus, Trash2, Save, Lock, Unlock, Eye, EyeOff } from 'lucide-react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { credentialsService, Credential } from '../../services/credentialsService';
import { useToast } from '../../contexts/ToastContext';

interface CustomCredential {
  key: string;
  value: string;
  description: string;
  originalValue?: string;
  originalKey?: string; // Track original key for renaming
  hasChanges?: boolean;
  is_encrypted?: boolean;
  showValue?: boolean; // Track per-credential visibility
  isNew?: boolean; // Track if this is a new unsaved credential
}

export const APIKeysSection = () => {
  const [customCredentials, setCustomCredentials] = useState<CustomCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const { showToast } = useToast();

  // Load credentials on mount
  useEffect(() => {
    loadCredentials();
  }, []);

  // Track unsaved changes
  useEffect(() => {
    const hasChanges = customCredentials.some(cred => cred.hasChanges || cred.isNew);
    setHasUnsavedChanges(hasChanges);
  }, [customCredentials]);

  const loadCredentials = async () => {
    try {
      setLoading(true);
      
      // Load all credentials
      const allCredentials = await credentialsService.getAllCredentials();
      
      // Filter to only show API keys (credentials that end with _KEY or _API)
      const apiKeys = allCredentials.filter(cred => {
        const key = cred.key.toUpperCase();
        return key.includes('_KEY') || key.includes('_API') || key.includes('API_');
      });
      
      // Convert to UI format
      const uiCredentials = apiKeys.map(cred => ({
        key: cred.key,
        value: cred.value || '',
        description: cred.description || '',
        originalValue: cred.value || '',
        originalKey: cred.key, // Track original key for updates
        hasChanges: false,
        is_encrypted: cred.is_encrypted || false,
        showValue: false,
        isNew: false
      }));
      
      setCustomCredentials(uiCredentials);
    } catch (err) {
      console.error('Failed to load credentials:', err);
      showToast('Failed to load credentials', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAddNewRow = () => {
    const newCred: CustomCredential = {
      key: '',
      value: '',
      description: '',
      originalValue: '',
      hasChanges: true,
      is_encrypted: true, // Default to encrypted
      showValue: true, // Show value for new entries
      isNew: true
    };
    
    setCustomCredentials([...customCredentials, newCred]);
  };

  const updateCredential = (index: number, field: keyof CustomCredential, value: any) => {
    setCustomCredentials(customCredentials.map((cred, i) => {
      if (i === index) {
        const updated = { ...cred, [field]: value };
        // Mark as changed if value differs from original
        if (field === 'key' || field === 'value' || field === 'is_encrypted') {
          updated.hasChanges = true;
        }
        return updated;
      }
      return cred;
    }));
  };

  const toggleValueVisibility = (index: number) => {
    updateCredential(index, 'showValue', !customCredentials[index].showValue);
  };

  const toggleEncryption = (index: number) => {
    updateCredential(index, 'is_encrypted', !customCredentials[index].is_encrypted);
  };

  const deleteCredential = async (index: number) => {
    const cred = customCredentials[index];
    
    if (cred.isNew) {
      // Just remove from UI if it's not saved yet
      setCustomCredentials(customCredentials.filter((_, i) => i !== index));
    } else {
      try {
        await credentialsService.deleteCredential(cred.key);
        setCustomCredentials(customCredentials.filter((_, i) => i !== index));
        showToast(`Deleted ${cred.key}`, 'success');
      } catch (err) {
        console.error('Failed to delete credential:', err);
        showToast('Failed to delete credential', 'error');
      }
    }
  };

  const saveAllChanges = async () => {
    setSaving(true);
    let hasErrors = false;
    
    for (const cred of customCredentials) {
      if (cred.hasChanges || cred.isNew) {
        if (!cred.key) {
          showToast('Key name cannot be empty', 'error');
          hasErrors = true;
          continue;
        }
        
        try {
          if (cred.isNew) {
            await credentialsService.createCredential({
              key: cred.key,
              value: cred.value,
              description: cred.description,
              is_encrypted: cred.is_encrypted || false,
              category: 'api_keys'
            });
          } else {
            // If key has changed, delete old and create new
            if (cred.originalKey && cred.originalKey !== cred.key) {
              await credentialsService.deleteCredential(cred.originalKey);
              await credentialsService.createCredential({
                key: cred.key,
                value: cred.value,
                description: cred.description,
                is_encrypted: cred.is_encrypted || false,
                category: 'api_keys'
              });
            } else {
              // Just update the value
              await credentialsService.updateCredential({
                key: cred.key,
                value: cred.value,
                description: cred.description,
                is_encrypted: cred.is_encrypted || false,
                category: 'api_keys'
              });
            }
          }
        } catch (err) {
          console.error(`Failed to save ${cred.key}:`, err);
          showToast(`Failed to save ${cred.key}`, 'error');
          hasErrors = true;
        }
      }
    }
    
    if (!hasErrors) {
      showToast('All changes saved successfully!', 'success');
      await loadCredentials(); // Reload to get fresh data
    }
    
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <Card accentColor="pink" className="space-y-5">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <Card accentColor="pink" className="p-8">
        <div className="space-y-4">
          {/* Description text */}
          <p className="text-sm text-gray-600 dark:text-zinc-400 mb-4">
            Manage your API keys and credentials for various services used by Archon.
          </p>

          {/* Credentials list */}
          <div className="space-y-3">
            {/* Header row */}
            <div className="grid grid-cols-[240px_1fr_40px] gap-4 px-2 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <div>Key Name</div>
              <div>Value</div>
              <div></div>
            </div>

            {/* Credential rows */}
            {customCredentials.map((cred, index) => (
              <div 
                key={index} 
                className="grid grid-cols-[240px_1fr_40px] gap-4 items-center"
              >
                {/* Key name column */}
                <div className="flex items-center">
                  <input
                    type="text"
                    value={cred.key}
                    onChange={(e) => updateCredential(index, 'key', e.target.value)}
                    placeholder="Enter key name"
                    className="w-full px-3 py-2 rounded-md bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm font-mono"
                  />
                </div>

                {/* Value column with encryption toggle */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 relative">
                    <input
                      type={cred.showValue ? 'text' : 'password'}
                      value={cred.value}
                      onChange={(e) => updateCredential(index, 'value', e.target.value)}
                      placeholder={cred.is_encrypted && !cred.value ? 'Enter new value (encrypted)' : 'Enter value'}
                      className="w-full px-3 py-2 pr-20 rounded-md bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm"
                    />
                    
                    {/* Show/Hide value button */}
                    <button
                      type="button"
                      onClick={() => toggleValueVisibility(index)}
                      className="absolute right-10 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                      title={cred.showValue ? 'Hide value' : 'Show value'}
                    >
                      {cred.showValue ? (
                        <EyeOff className="w-4 h-4 text-gray-500" />
                      ) : (
                        <Eye className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    
                    {/* Encryption toggle */}
                    <button
                      type="button"
                      onClick={() => toggleEncryption(index)}
                      className={`
                        absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded transition-colors
                        ${cred.is_encrypted 
                          ? 'text-pink-600 dark:text-pink-400 hover:bg-pink-100 dark:hover:bg-pink-900/20' 
                          : 'text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                        }
                      `}
                      title={cred.is_encrypted ? 'Encrypted' : 'Not encrypted'}
                    >
                      {cred.is_encrypted ? (
                        <Lock className="w-4 h-4" />
                      ) : (
                        <Unlock className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Actions column */}
                <div className="flex items-center justify-center">
                  <button
                    onClick={() => deleteCredential(index)}
                    className="p-1 rounded text-gray-400 hover:text-red-600 transition-colors"
                    title="Delete credential"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add credential button and quick suggestions */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
            <Button
              variant="outline"
              onClick={handleAddNewRow}
              accentColor="pink"
              size="sm"
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Add Credential
            </Button>

            {/* Quick add suggestions */}
            <div className="space-y-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Quick add common API keys:</p>
              <div className="flex flex-wrap gap-2">
                {['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GOOGLE_API_KEY'].map(keyName => (
                  <button
                    key={keyName}
                    onClick={() => {
                      // Check if key already exists
                      const exists = customCredentials.some(cred => cred.key === keyName);
                      if (!exists) {
                        const newCred: CustomCredential = {
                          key: keyName,
                          value: '',
                          description: '',
                          originalValue: '',
                          hasChanges: true,
                          is_encrypted: true,
                          showValue: true,
                          isNew: true
                        };
                        setCustomCredentials([...customCredentials, newCred]);
                      } else {
                        showToast(`${keyName} already exists`, 'info');
                      }
                    }}
                    className="px-2 py-1 text-xs rounded-md bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 transition-colors"
                  >
                    {keyName}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Save all changes button */}
          {hasUnsavedChanges && (
            <div className="pt-4 flex justify-center gap-2">
              <Button
                variant="ghost"
                onClick={loadCredentials}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={saveAllChanges}
                accentColor="green"
                disabled={saving}
                className="shadow-emerald-500/20 shadow-sm"
              >
                {saving ? (
                  <>
                    <div className="w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    Save All Changes
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Security Notice */}
          <div className="p-3 mt-6 mb-2 bg-gray-50 dark:bg-black/40 rounded-md flex items-start gap-3">
            <div className="w-5 h-5 text-pink-500 mt-0.5 flex-shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <p>
                Click the lock icon to toggle encryption for each credential. Encrypted values are stored securely and only decrypted when needed.
              </p>
            </div>
          </div>
        </div>
      </Card>
  );
};