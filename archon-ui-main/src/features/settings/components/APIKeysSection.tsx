import { useState, useEffect } from 'react';
import { Key, Plus, Trash2, Save, Lock, Unlock, Eye, EyeOff } from 'lucide-react';
import { Input } from '@/features/ui/primitives/input';
import { Button } from '@/features/ui/primitives/button';
import { Card } from '@/features/ui/primitives/card';
import { credentialsService, Credential } from '../../../services/credentialsService';
import { useToast } from '../../shared/hooks/useToast';

interface CustomCredential {
  key: string;
  value: string;
  description: string;
  originalValue?: string;
  originalKey?: string;
  hasChanges?: boolean;
  is_encrypted?: boolean;
  showValue?: boolean;
  isNew?: boolean;
  isFromBackend?: boolean;
}

export const APIKeysSection = () => {
  const [customCredentials, setCustomCredentials] = useState<CustomCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const { showToast } = useToast();

  useEffect(() => {
    loadCredentials();
  }, []);

  useEffect(() => {
    const hasChanges = customCredentials.some(cred => cred.hasChanges || cred.isNew);
    setHasUnsavedChanges(hasChanges);
  }, [customCredentials]);

  const loadCredentials = async () => {
    try {
      setLoading(true);

      const allCredentials = await credentialsService.getAllCredentials();

      const apiKeys = allCredentials.filter(cred => {
        const key = cred.key.toUpperCase();
        return key.includes('_KEY') || key.includes('_API') || key.includes('API_');
      });

      const uiCredentials = apiKeys.map(cred => {
        const isEncryptedFromBackend = cred.is_encrypted && cred.value === '[ENCRYPTED]';

        return {
          key: cred.key,
          value: cred.value || '',
          description: cred.description || '',
          originalValue: cred.value || '',
          originalKey: cred.key,
          hasChanges: false,
          is_encrypted: cred.is_encrypted || false,
          showValue: false,
          isNew: false,
          isFromBackend: !cred.isNew,
        };
      });

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
      is_encrypted: true,
      showValue: true,
      isNew: true,
      isFromBackend: false
    };

    setCustomCredentials([...customCredentials, newCred]);
  };

  const updateCredential = (index: number, field: keyof CustomCredential, value: any) => {
    setCustomCredentials(customCredentials.map((cred, i) => {
      if (i === index) {
        const updated = { ...cred, [field]: value };
        if (field === 'key' || field === 'value' || field === 'is_encrypted') {
          updated.hasChanges = true;
        }
        if (field === 'value' && cred.isFromBackend && cred.is_encrypted && cred.value === '[ENCRYPTED]') {
          updated.isFromBackend = false;
          updated.showValue = false;
          updated.value = '';
        }
        return updated;
      }
      return cred;
    }));
  };

  const toggleValueVisibility = (index: number) => {
    const cred = customCredentials[index];
    if (cred.isFromBackend && cred.is_encrypted && cred.value === '[ENCRYPTED]') {
      showToast('Encrypted credentials cannot be viewed. Edit to make changes.', 'warning');
      return;
    }
    updateCredential(index, 'showValue', !cred.showValue);
  };

  const toggleEncryption = (index: number) => {
    const cred = customCredentials[index];
    if (cred.isFromBackend && cred.is_encrypted && cred.value === '[ENCRYPTED]') {
      showToast('Edit the credential value to make changes.', 'warning');
      return;
    }
    updateCredential(index, 'is_encrypted', !cred.is_encrypted);
  };

  const deleteCredential = async (index: number) => {
    const cred = customCredentials[index];

    if (cred.isNew) {
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
      await loadCredentials();
    }

    setSaving(false);
  };

  const inputStateVariants = {
    readonly: "bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400",
    editable: "bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700"
  } satisfies Record<string, string>;

  const buttonStateVariants = {
    disabled: "cursor-not-allowed opacity-50",
    enabled: "hover:bg-gray-200 dark:hover:bg-gray-700"
  } satisfies Record<string, string>;

  const encryptionButtonVariants = {
    disabled: "cursor-not-allowed opacity-50 text-pink-400",
    encrypted: "text-pink-600 dark:text-pink-400 hover:bg-pink-100 dark:hover:bg-pink-900/20",
    unencrypted: "text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
  } satisfies Record<string, string>;

  if (loading) {
    return (
      <Card edgePosition="top" edgeColor="pink">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
          <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
        </div>
      </Card>
    );
  }

  return (
    <Card edgePosition="top" edgeColor="pink">
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-zinc-400 mb-4">
            Manage your API keys and credentials for various services used by Archon.
          </p>

          <div className="space-y-3">
            <div className="grid grid-cols-[240px_1fr_40px] gap-4 px-2 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <div>Key Name</div>
              <div>Value</div>
              <div></div>
            </div>

            {customCredentials.map((cred, index) => {
              const isReadonly = cred.isFromBackend && cred.is_encrypted && cred.value === '[ENCRYPTED]';

              return (
                <div
                  key={index}
                  className="grid grid-cols-[240px_1fr_40px] gap-4 items-center"
                >
                  <div className="flex items-center">
                    <Input
                      type="text"
                      value={cred.key}
                      onChange={(e) => updateCredential(index, 'key', e.target.value)}
                      placeholder="Enter key name"
                      className="w-full text-sm font-mono"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex-1 relative">
                      <Input
                        type={cred.showValue ? 'text' : 'password'}
                        value={cred.value}
                        onChange={(e) => updateCredential(index, 'value', e.target.value)}
                        placeholder={cred.is_encrypted && !cred.value ? 'Enter new value (encrypted)' : 'Enter value'}
                        className={`w-full pr-20 text-sm ${isReadonly ? inputStateVariants.readonly : inputStateVariants.editable}`}
                        title={isReadonly ? 'Click to edit this encrypted credential' : undefined}
                      />

                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleValueVisibility(index)}
                        disabled={isReadonly}
                        className={`absolute right-10 top-1/2 -translate-y-1/2 h-7 w-7 ${isReadonly ? buttonStateVariants.disabled : buttonStateVariants.enabled}`}
                        aria-label={isReadonly ? 'Edit credential to view and modify' : (cred.showValue ? 'Hide value' : 'Show value')}
                        aria-pressed={cred.showValue}
                      >
                        {cred.showValue ? (
                          <EyeOff className="w-4 h-4 text-gray-500" aria-hidden="true" />
                        ) : (
                          <Eye className="w-4 h-4 text-gray-500" aria-hidden="true" />
                        )}
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleEncryption(index)}
                        disabled={isReadonly}
                        className={`absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 ${
                          isReadonly
                            ? encryptionButtonVariants.disabled
                            : cred.is_encrypted
                            ? encryptionButtonVariants.encrypted
                            : encryptionButtonVariants.unencrypted
                        }`}
                        aria-label={
                          isReadonly
                            ? 'Edit credential to modify encryption'
                            : cred.is_encrypted ? 'Encrypted - click to decrypt' : 'Not encrypted - click to encrypt'
                        }
                        aria-pressed={cred.is_encrypted}
                      >
                        {cred.is_encrypted ? (
                          <Lock className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <Unlock className="w-4 h-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center justify-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteCredential(index)}
                      className="h-7 w-7 text-gray-400 hover:text-red-600"
                      aria-label={`Delete credential ${cred.key || 'entry'}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <Button
              variant="outline"
              onClick={handleAddNewRow}
              size="sm"
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Add Credential
            </Button>
          </div>

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
                variant="default"
                onClick={saveAllChanges}
                disabled={saving}
                loading={saving}
              >
                {!saving && <Save className="w-4 h-4 mr-2" />}
                {saving ? 'Saving...' : 'Save All Changes'}
              </Button>
            </div>
          )}

          <div className="p-3 mt-6 mb-2 bg-gray-50 dark:bg-black/40 rounded-md flex items-start gap-3">
            <div className="w-5 h-5 text-pink-500 mt-0.5 flex-shrink-0">
              <Lock className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <p>
                Encrypted credentials are masked after saving. Click on a masked credential to edit it - this allows you to change the value and encryption settings.
              </p>
            </div>
          </div>
        </div>
      </Card>
  );
};
