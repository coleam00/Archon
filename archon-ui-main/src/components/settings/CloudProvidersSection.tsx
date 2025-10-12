import { useState, useEffect } from 'react';
import { Cloud, Lock, Unlock, Eye, EyeOff, Save, Loader, AlertCircle } from 'lucide-react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { credentialsService } from '../../services/credentialsService';
import { useToast } from '../../features/shared/hooks/useToast';

// Cloud provider configurations
const CLOUD_PROVIDERS = {
    azure: {
        name: 'Azure OpenAI',
        icon: (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.379 23.343a1.62 1.62 0 0 0 1.536-2.14v.002L17.35 1.76A1.62 1.62 0 0 0 15.816.657H8.184A1.62 1.62 0 0 0 6.65 1.76L.086 21.204a1.62 1.62 0 0 0 1.536 2.139h4.741a1.62 1.62 0 0 0 1.535-1.103l.977-2.892 4.947 3.675c.28.208.618.32.966.32h7.591z" />
            </svg>
        ),
        color: 'blue',
        credentials: [
            {
                key: 'AZURE_OPENAI_API_KEY',
                label: 'API Key',
                placeholder: 'Enter your Azure OpenAI API key',
                type: 'password',
                encrypted: true,
                required: true,
                description: 'Your Azure OpenAI resource API key from Azure Portal'
            },
            {
                key: 'AZURE_OPENAI_ENDPOINT',
                label: 'Endpoint',
                placeholder: 'https://your-resource.openai.azure.com/',
                type: 'text',
                encrypted: false,
                required: true,
                description: 'Your Azure OpenAI resource endpoint URL'
            },
            {
                key: 'AZURE_OPENAI_API_VERSION',
                label: 'API Version',
                placeholder: '2024-02-15-preview',
                type: 'text',
                encrypted: false,
                required: true,
                description: 'API version (YYYY-MM-DD format)'
            },
            {
                key: 'AZURE_OPENAI_DEPLOYMENT',
                label: 'Deployment Name',
                placeholder: 'my-gpt4-deployment',
                type: 'text',
                encrypted: false,
                required: false,
                description: 'Default deployment name (optional, can be set per operation)'
            }
        ]
    },
    aws: {
        name: 'AWS Bedrock',
        icon: (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6.763 10.036c.012-.047.029-.094.029-.141 0-.155-.056-.294-.165-.403l-2.619-2.62a.562.562 0 0 0-.399-.161.605.605 0 0 0-.445.189c-.117.129-.173.268-.173.403s.056.269.173.403l2.619 2.619a.548.548 0 0 0 .386.165c.06 0 .115-.012.167-.029zm12.474 0c.051.017.107.029.166.029a.548.548 0 0 0 .386-.165l2.619-2.619c.117-.134.173-.268.173-.403s-.056-.269-.173-.403a.605.605 0 0 0-.445-.189.562.562 0 0 0-.399.161l-2.619 2.62a.648.648 0 0 0-.165.403c0 .047.017.094.029.141zm-7.054 6.238c-.188-.001-.367.071-.495.195l-2.793 2.795-.527.53a.619.619 0 0 0-.166.423c0 .151.056.291.166.406.115.115.256.166.406.166.151 0 .291-.051.406-.166l2.852-2.846a.701.701 0 0 0 .192-.495.68.68 0 0 0-.192-.495.68.68 0 0 0-.495-.192zm0-4.806a.68.68 0 0 0-.495.192.68.68 0 0 0-.192.495c0 .188.071.367.192.495l2.852 2.846a.57.57 0 0 0 .406.166.57.57 0 0 0 .406-.166.584.584 0 0 0 .166-.406.619.619 0 0 0-.166-.423l-.527-.53-2.793-2.795a.68.68 0 0 0-.495-.195zm-4.806 2.403a.68.68 0 0 0-.495.192.68.68 0 0 0-.192.495c0 .188.071.367.192.495l2.846 2.852c.115.115.256.166.406.166.151 0 .291-.051.406-.166a.57.57 0 0 0 .166-.406.619.619 0 0 0-.166-.423l-.53-.527-2.795-2.793a.68.68 0 0 0-.495-.192zm9.612 0a.68.68 0 0 0-.495.192l-2.795 2.793-.53.527a.619.619 0 0 0-.166.423c0 .151.051.291.166.406.115.115.256.166.406.166.151 0 .291-.051.406-.166l2.846-2.852a.701.701 0 0 0 .192-.495.68.68 0 0 0-.192-.495.68.68 0 0 0-.495-.192zm0-4.806a.68.68 0 0 0-.495.192l-2.793 2.795-.527.53a.619.619 0 0 0-.166.423c0 .151.051.291.166.406.115.115.256.166.406.166.151 0 .291-.051.406-.166l2.852-2.846a.701.701 0 0 0 .192-.495.68.68 0 0 0-.192-.495.68.68 0 0 0-.495-.192z" />
            </svg>
        ),
        color: 'orange',
        credentials: [
            {
                key: 'AWS_ACCESS_KEY_ID',
                label: 'Access Key ID',
                placeholder: 'Enter your AWS Access Key ID',
                type: 'password',
                encrypted: true,
                required: true,
                description: 'AWS IAM Access Key ID'
            },
            {
                key: 'AWS_SECRET_ACCESS_KEY',
                label: 'Secret Access Key',
                placeholder: 'Enter your AWS Secret Access Key',
                type: 'password',
                encrypted: true,
                required: true,
                description: 'AWS IAM Secret Access Key'
            },
            {
                key: 'AWS_REGION',
                label: 'Region',
                placeholder: 'us-east-1',
                type: 'text',
                encrypted: false,
                required: true,
                description: 'AWS region for Bedrock (e.g., us-east-1, us-west-2)'
            },
            {
                key: 'AWS_BEDROCK_MODEL_ID',
                label: 'Model ID',
                placeholder: 'anthropic.claude-3-sonnet-20240229-v1:0',
                type: 'text',
                encrypted: false,
                required: false,
                description: 'Default Bedrock model ID (optional)'
            }
        ]
    }
};

interface CredentialValue {
    value: string;
    showValue: boolean;
    hasChanges: boolean;
    originalValue: string;
    isFromBackend: boolean;
}

type ProviderKey = keyof typeof CLOUD_PROVIDERS;

export const CloudProvidersSection = () => {
    const [selectedProvider, setSelectedProvider] = useState<ProviderKey>('azure');
    const [credentialValues, setCredentialValues] = useState<Record<string, CredentialValue>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

    const { showToast } = useToast();

    useEffect(() => {
        loadCredentials();
    }, []);

    useEffect(() => {
        // Check if there are unsaved changes
        const hasChanges = Object.values(credentialValues).some(cred => cred.hasChanges);
        setHasUnsavedChanges(hasChanges);
    }, [credentialValues]);

    const loadCredentials = async () => {
        try {
            setLoading(true);

            // Load all cloud provider credentials
            const allCredentials = await credentialsService.getAllCredentials();

            const values: Record<string, CredentialValue> = {};

            // Initialize all credential values from backend
            Object.values(CLOUD_PROVIDERS).forEach(provider => {
                provider.credentials.forEach(cred => {
                    const backendCred = allCredentials.find(c => c.key === cred.key);
                    const isEncryptedFromBackend = backendCred?.is_encrypted && backendCred.value === '[ENCRYPTED]';

                    values[cred.key] = {
                        value: backendCred?.value || '',
                        showValue: false,
                        hasChanges: false,
                        originalValue: backendCred?.value || '',
                        isFromBackend: !!backendCred && !backendCred.isNew
                    };
                });
            });

            setCredentialValues(values);
        } catch (err) {
            console.error('Failed to load cloud credentials:', err);
            showToast('Failed to load cloud provider credentials', 'error');
        } finally {
            setLoading(false);
        }
    };

    const updateCredentialValue = (key: string, value: string) => {
        setCredentialValues(prev => {
            const current = prev[key];
            const updated = {
                ...current,
                value,
                hasChanges: true
            };

            // If editing an encrypted credential from backend, make it editable
            if (current.isFromBackend && current.value === '[ENCRYPTED]' && value !== '[ENCRYPTED]') {
                updated.isFromBackend = false;
                updated.showValue = false;
                if (value === '') {
                    // If they click to edit but haven't entered anything, clear the placeholder
                    updated.value = '';
                }
            }

            return {
                ...prev,
                [key]: updated
            };
        });
    };

    const toggleValueVisibility = (key: string) => {
        const cred = credentialValues[key];
        if (cred.isFromBackend && cred.value === '[ENCRYPTED]') {
            showToast('Encrypted credentials cannot be viewed. Edit to make changes.', 'warning');
            return;
        }

        setCredentialValues(prev => ({
            ...prev,
            [key]: {
                ...prev[key],
                showValue: !prev[key].showValue
            }
        }));
    };

    const saveChanges = async () => {
        setSaving(true);
        let hasErrors = false;
        const provider = CLOUD_PROVIDERS[selectedProvider];

        try {
            for (const credConfig of provider.credentials) {
                const credValue = credentialValues[credConfig.key];

                if (!credValue.hasChanges) continue;

                // Validate required fields
                if (credConfig.required && !credValue.value) {
                    showToast(`${credConfig.label} is required`, 'error');
                    hasErrors = true;
                    continue;
                }

                // Skip if value is still [ENCRYPTED] (unchanged)
                if (credValue.value === '[ENCRYPTED]') {
                    continue;
                }

                try {
                    // Check if credential exists
                    const existing = await credentialsService.getCredential(credConfig.key).catch(() => null);

                    if (existing) {
                        // Update existing
                        await credentialsService.updateCredential({
                            key: credConfig.key,
                            value: credValue.value,
                            is_encrypted: credConfig.encrypted,
                            category: 'cloud_providers',
                            description: credConfig.description
                        });
                    } else {
                        // Create new
                        await credentialsService.createCredential({
                            key: credConfig.key,
                            value: credValue.value,
                            is_encrypted: credConfig.encrypted,
                            category: 'cloud_providers',
                            description: credConfig.description
                        });
                    }
                } catch (err) {
                    console.error(`Failed to save ${credConfig.key}:`, err);
                    showToast(`Failed to save ${credConfig.label}`, 'error');
                    hasErrors = true;
                }
            }

            if (!hasErrors) {
                showToast(`${provider.name} credentials saved successfully!`, 'success');
                await loadCredentials(); // Reload to get fresh data
            }
        } finally {
            setSaving(false);
        }
    };

    const discardChanges = () => {
        loadCredentials();
    };

    if (loading) {
        return (
            <Card accentColor="blue" className="p-8">
                <div className="flex items-center justify-center py-12">
                    <Loader className="animate-spin text-blue-500" size={32} />
                </div>
            </Card>
        );
    }

    const currentProvider = CLOUD_PROVIDERS[selectedProvider];

    return (
        <Card accentColor="blue" className="p-8">
            <div className="space-y-6">
                {/* Description */}
                <div className="flex items-start gap-3">
                    <Cloud className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
                    <div>
                        <p className="text-sm text-gray-600 dark:text-zinc-400">
                            Configure cloud-based AI services. These providers offer enterprise-grade security, compliance, and regional availability.
                        </p>
                    </div>
                </div>

                {/* Provider Selector */}
                <div className="flex gap-2 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
                    {(Object.keys(CLOUD_PROVIDERS) as ProviderKey[]).map(providerKey => {
                        const provider = CLOUD_PROVIDERS[providerKey];
                        const isSelected = selectedProvider === providerKey;

                        return (
                            <button
                                key={providerKey}
                                onClick={() => setSelectedProvider(providerKey)}
                                className={`
                  flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-md
                  font-medium text-sm transition-all duration-200
                  ${isSelected
                                        ? `bg-white dark:bg-gray-900 text-${provider.color}-600 shadow-sm`
                                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                                    }
                `}
                            >
                                <span className={isSelected ? `text-${provider.color}-600` : ''}>
                                    {provider.icon}
                                </span>
                                {provider.name}
                            </button>
                        );
                    })}
                </div>

                {/* Credentials Form */}
                <div className="space-y-4 mt-6">
                    {currentProvider.credentials.map(credConfig => {
                        const credValue = credentialValues[credConfig.key] || {
                            value: '',
                            showValue: false,
                            hasChanges: false,
                            originalValue: '',
                            isFromBackend: false
                        };

                        const isEncrypted = credConfig.encrypted;
                        const isFromBackend = credValue.isFromBackend && credValue.value === '[ENCRYPTED]';

                        return (
                            <div key={credConfig.key} className="space-y-2">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                                    {credConfig.label}
                                    {credConfig.required && <span className="text-red-500 ml-1">*</span>}
                                </label>

                                <div className="relative">
                                    <input
                                        type={credValue.showValue ? 'text' : credConfig.type}
                                        value={credValue.value}
                                        onChange={(e) => updateCredentialValue(credConfig.key, e.target.value)}
                                        placeholder={isFromBackend ? 'Click to edit encrypted value' : credConfig.placeholder}
                                        className={`
                      w-full px-4 py-2 pr-24 rounded-md border text-sm
                      ${isFromBackend
                                                ? 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400'
                                                : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700'
                                            }
                      focus:outline-none focus:ring-2 focus:ring-${currentProvider.color}-500 focus:border-transparent
                    `}
                                        title={isFromBackend ? 'Click to edit this encrypted credential' : undefined}
                                    />

                                    {/* Show/Hide button for password fields */}
                                    {credConfig.type === 'password' && (
                                        <button
                                            type="button"
                                            onClick={() => toggleValueVisibility(credConfig.key)}
                                            disabled={isFromBackend}
                                            className={`
                        absolute right-14 top-1/2 -translate-y-1/2 p-1.5 rounded transition-colors
                        ${isFromBackend
                                                    ? 'cursor-not-allowed opacity-50'
                                                    : 'hover:bg-gray-200 dark:hover:bg-gray-700'
                                                }
                      `}
                                            title={isFromBackend ? 'Edit to view' : credValue.showValue ? 'Hide value' : 'Show value'}
                                        >
                                            {credValue.showValue ? (
                                                <EyeOff className="w-4 h-4 text-gray-500" />
                                            ) : (
                                                <Eye className="w-4 h-4 text-gray-500" />
                                            )}
                                        </button>
                                    )}

                                    {/* Encryption indicator */}
                                    {isEncrypted && (
                                        <div
                                            className={`
                        absolute right-2 top-1/2 -translate-y-1/2 p-1.5
                        text-${currentProvider.color}-600 dark:text-${currentProvider.color}-400
                      `}
                                            title="This field is encrypted"
                                        >
                                            <Lock className="w-4 h-4" />
                                        </div>
                                    )}
                                </div>

                                {credConfig.description && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        {credConfig.description}
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Save Button */}
                {hasUnsavedChanges && (
                    <div className="pt-4 flex justify-center gap-2 border-t border-gray-200 dark:border-gray-700">
                        <Button
                            variant="ghost"
                            onClick={discardChanges}
                            disabled={saving}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={saveChanges}
                            accentColor="green"
                            disabled={saving}
                            className="shadow-emerald-500/20 shadow-sm"
                        >
                            {saving ? (
                                <>
                                    <Loader className="w-4 h-4 mr-2 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4 mr-2" />
                                    Save Changes
                                </>
                            )}
                        </Button>
                    </div>
                )}

                {/* Info Box */}
                <div className="p-4 mt-6 bg-blue-50 dark:bg-blue-900/20 rounded-md flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-blue-700 dark:text-blue-300 space-y-2">
                        <p className="font-medium">Cloud Provider Setup:</p>
                        <ul className="list-disc list-inside space-y-1 text-blue-600 dark:text-blue-400">
                            <li>Encrypted credentials are masked after saving</li>
                            <li>Set LLM_PROVIDER to '<span className="font-mono">azure-openai</span>' or '<span className="font-mono">aws-bedrock</span>' in RAG Settings to use</li>
                            <li>Regional availability and pricing may vary by provider</li>
                        </ul>
                    </div>
                </div>
            </div>
        </Card>
    );
};
