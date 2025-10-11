import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, Save, Loader, Cog } from 'lucide-react';
import { Input } from '@/features/ui/primitives/input';
import { Button } from '@/features/ui/primitives/button';
import { Card } from '@/features/ui/primitives/card';
import { cn } from '@/features/ui/primitives/styles';
import { LuBrainCircuit } from 'react-icons/lu';
import { PiDatabaseThin } from 'react-icons/pi';
import { useToast } from '@/features/shared/hooks/useToast';
import { credentialsService } from '../../../services/credentialsService';
import { ModelsConfigDialog } from '../ollama/components/ModelsConfigDialog';
import { useProviderModels, useSetProviderModel } from '../hooks/useProviderModels';
import type { ProviderKey, ProviderModelMap } from '../services/providerModelsService';

const EMBEDDING_CAPABLE_PROVIDERS: ProviderKey[] = ['openai', 'google', 'ollama'];

const getDefaultModels = (provider: ProviderKey): { chatModel: string; embeddingModel: string } => {
  const chatDefaults: Record<ProviderKey, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-20241022',
    google: 'gemini-1.5-flash',
    grok: 'grok-3-mini',
    openrouter: 'openai/gpt-4o-mini',
    ollama: 'llama3:8b'
  };

  const embeddingDefaults: Record<ProviderKey, string> = {
    openai: 'text-embedding-3-small',
    anthropic: 'text-embedding-3-small',
    google: 'text-embedding-004',
    grok: 'text-embedding-3-small',
    openrouter: 'text-embedding-3-small',
    ollama: 'nomic-embed-text'
  };

  return {
    chatModel: chatDefaults[provider],
    embeddingModel: embeddingDefaults[provider]
  };
};

const colorStyles: Record<ProviderKey, string> = {
  openai: 'border-green-500 bg-green-500/10',
  google: 'border-blue-500 bg-blue-500/10',
  openrouter: 'border-cyan-500 bg-cyan-500/10',
  ollama: 'border-purple-500 bg-purple-500/10',
  anthropic: 'border-orange-500 bg-orange-500/10',
  grok: 'border-yellow-500 bg-yellow-500/10',
};

const gridCols = {
  chat: "grid-cols-6",
  embedding: "grid-cols-3"
} satisfies Record<'chat' | 'embedding', string>;

const logoBackgrounds = {
  openai: "bg-white rounded p-1",
  grok: "bg-white rounded p-1",
  google: "",
  openrouter: "",
  ollama: "",
  anthropic: "bg-white rounded p-1"
} satisfies Record<ProviderKey, string>;

const providerNameFontSizes = {
  openrouter: "text-xs",
  openai: "text-sm",
  google: "text-sm",
  ollama: "text-sm",
  anthropic: "text-sm",
  grok: "text-sm"
} satisfies Record<ProviderKey, string>;

const alertVariants = {
  warning: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-300',
  error: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
} satisfies Record<'warning' | 'error', string>;

const providerDisplayNames: Record<ProviderKey, string> = {
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  grok: 'Grok',
};

const isProviderKey = (value: unknown): value is ProviderKey =>
  typeof value === 'string' && ['openai', 'google', 'openrouter', 'ollama', 'anthropic', 'grok'].includes(value);

const DEFAULT_OLLAMA_URL = 'http://host.docker.internal:11434/v1';

const PROVIDER_CREDENTIAL_KEYS = [
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GROK_API_KEY',
] as const;

type ProviderCredentialKey = typeof PROVIDER_CREDENTIAL_KEYS[number];

const CREDENTIAL_PROVIDER_MAP: Record<ProviderCredentialKey, ProviderKey> = {
  OPENAI_API_KEY: 'openai',
  GOOGLE_API_KEY: 'google',
  ANTHROPIC_API_KEY: 'anthropic',
  OPENROUTER_API_KEY: 'openrouter',
  GROK_API_KEY: 'grok',
};

function getDisplayedChatModel(ragSettings: any): string {
  const provider = ragSettings.LLM_PROVIDER || 'openai';
  const modelChoice = ragSettings.MODEL_CHOICE;

  if (modelChoice !== undefined && modelChoice !== null) {
    return modelChoice;
  }

  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'google':
      return 'gemini-1.5-flash';
    case 'grok':
      return 'grok-3-mini';
    case 'ollama':
      return '';
    case 'openrouter':
      return 'anthropic/claude-3.5-sonnet';
    default:
      return 'gpt-4o-mini';
  }
}

function getDisplayedEmbeddingModel(ragSettings: any): string {
  const provider = ragSettings.EMBEDDING_PROVIDER || ragSettings.LLM_PROVIDER || 'openai';
  const embeddingModel = ragSettings.EMBEDDING_MODEL;

  if (embeddingModel !== undefined && embeddingModel !== null && embeddingModel !== '') {
    return embeddingModel;
  }

  switch (provider) {
    case 'openai':
      return 'text-embedding-3-small';
    case 'google':
      return 'text-embedding-004';
    case 'ollama':
      return '';
    case 'openrouter':
      return 'text-embedding-3-small';
    case 'anthropic':
      return 'text-embedding-3-small';
    case 'grok':
      return 'text-embedding-3-small';
    default:
      return 'text-embedding-3-small';
  }
}

function getModelPlaceholder(provider: ProviderKey): string {
  switch (provider) {
    case 'openai':
      return 'e.g., gpt-4o-mini';
    case 'anthropic':
      return 'e.g., claude-3-5-sonnet-20241022';
    case 'google':
      return 'e.g., gemini-1.5-flash';
    case 'grok':
      return 'e.g., grok-2-latest';
    case 'ollama':
      return 'e.g., llama2, mistral';
    case 'openrouter':
      return 'e.g., anthropic/claude-3.5-sonnet';
    default:
      return 'e.g., gpt-4o-mini';
  }
}

function getEmbeddingPlaceholder(provider: ProviderKey): string {
  switch (provider) {
    case 'openai':
      return 'Default: text-embedding-3-small';
    case 'anthropic':
      return 'Claude does not provide embedding models';
    case 'google':
      return 'e.g., text-embedding-004';
    case 'grok':
      return 'Grok does not provide embedding models';
    case 'ollama':
      return 'e.g., nomic-embed-text';
    case 'openrouter':
      return 'e.g., text-embedding-3-small';
    default:
      return 'Default: text-embedding-3-small';
  }
}

interface ModelsSectionProps {
  ragSettings: any;
  setRagSettings: (settings: any) => void;
}

export const ModelsSection = ({ ragSettings, setRagSettings }: ModelsSectionProps) => {
  const [saving, setSaving] = useState(false);
  const [showModelsConfigDialog, setShowModelsConfigDialog] = useState(false);

  const { data: providerModels, isLoading: providerModelsLoading } = useProviderModels();
  const setProviderModelMutation = useSetProviderModel();

  const [chatProvider, setChatProvider] = useState<ProviderKey>(() =>
    (ragSettings.LLM_PROVIDER as ProviderKey) || 'openai'
  );
  const [embeddingProvider, setEmbeddingProvider] = useState<ProviderKey>(() =>
    (ragSettings.EMBEDDING_PROVIDER as ProviderKey) || 'openai'
  );
  const [activeSelection, setActiveSelection] = useState<'chat' | 'embedding'>('chat');

  const [llmInstanceConfig, setLLMInstanceConfig] = useState({
    name: ragSettings.LLM_INSTANCE_NAME || '',
    url: ragSettings.LLM_BASE_URL || 'http://host.docker.internal:11434/v1'
  });

  const [embeddingInstanceConfig, setEmbeddingInstanceConfig] = useState({
    name: ragSettings.OLLAMA_EMBEDDING_INSTANCE_NAME || '',
    url: ragSettings.OLLAMA_EMBEDDING_URL || 'http://host.docker.internal:11434/v1'
  });

  const [apiCredentials, setApiCredentials] = useState<{[key: string]: boolean}>({});
  const [providerConnectionStatus, setProviderConnectionStatus] = useState<{
    [key: string]: { connected: boolean; checking: boolean; lastChecked?: Date }
  }>({});
  const [ollamaServerStatus, setOllamaServerStatus] = useState<'unknown' | 'online' | 'offline'>('unknown');
  const [ollamaManualConfirmed, setOllamaManualConfirmed] = useState(false);

  const { showToast } = useToast();
  const hasLoadedCredentialsRef = useRef(false);

  const reloadApiCredentials = useCallback(async () => {
    try {
      const statusResults = await credentialsService.checkCredentialStatus(
        Array.from(PROVIDER_CREDENTIAL_KEYS),
      );

      const credentials: { [key: string]: boolean } = {};

      for (const key of PROVIDER_CREDENTIAL_KEYS) {
        const result = statusResults[key];
        credentials[key] = !!result?.has_value;
      }

      setApiCredentials(credentials);
      hasLoadedCredentialsRef.current = true;
    } catch (error) {
      console.error('Failed to load API credentials for status checking:', error);
    }
  }, []);

  useEffect(() => {
    void reloadApiCredentials();
  }, [reloadApiCredentials]);

  useEffect(() => {
    if (!hasLoadedCredentialsRef.current) {
      return;
    }

    void reloadApiCredentials();
  }, [ragSettings.LLM_PROVIDER, reloadApiCredentials]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (Object.keys(ragSettings).length > 0) {
        void reloadApiCredentials();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [ragSettings.LLM_PROVIDER, reloadApiCredentials]);

  useEffect(() => {
    const needsDetection = chatProvider === 'ollama' || embeddingProvider === 'ollama';

    if (!needsDetection) {
      setOllamaServerStatus('unknown');
      return;
    }

    const baseUrl = (
      ragSettings.LLM_BASE_URL?.trim() ||
      ragSettings.OLLAMA_EMBEDDING_URL?.trim() ||
      DEFAULT_OLLAMA_URL
    );

    const normalizedUrl = baseUrl.replace('/v1', '').replace(/\/$/, '');

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          `/api/ollama/instances/health?instance_urls=${encodeURIComponent(normalizedUrl)}`,
          { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
        );

        if (cancelled) return;

        if (!response.ok) {
          setOllamaServerStatus('offline');
          return;
        }

        const data = await response.json();
        const instanceStatus = data.instance_status?.[normalizedUrl];
        setOllamaServerStatus(instanceStatus?.is_healthy ? 'online' : 'offline');
      } catch (error) {
        if (!cancelled) {
          setOllamaServerStatus('offline');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chatProvider, embeddingProvider, ragSettings.LLM_BASE_URL, ragSettings.OLLAMA_EMBEDDING_URL]);

  useEffect(() => {
    if (ragSettings.LLM_PROVIDER && ragSettings.LLM_PROVIDER !== chatProvider) {
      setChatProvider(ragSettings.LLM_PROVIDER as ProviderKey);
    }
  }, [ragSettings.LLM_PROVIDER]);

  useEffect(() => {
    if (ragSettings.EMBEDDING_PROVIDER && ragSettings.EMBEDDING_PROVIDER !== embeddingProvider) {
      setEmbeddingProvider(ragSettings.EMBEDDING_PROVIDER as ProviderKey);
    }
  }, [ragSettings.EMBEDDING_PROVIDER]);

  useEffect(() => {
    setOllamaManualConfirmed(false);
    setOllamaServerStatus('unknown');
  }, [ragSettings.LLM_BASE_URL, ragSettings.OLLAMA_EMBEDDING_URL, chatProvider, embeddingProvider]);

  const updateChatRagSettingsRef = useRef(true);
  const updateEmbeddingRagSettingsRef = useRef(true);

  useEffect(() => {
    if (updateChatRagSettingsRef.current && chatProvider !== ragSettings.LLM_PROVIDER) {
      setRagSettings(prev => ({
        ...prev,
        LLM_PROVIDER: chatProvider
      }));
    }
    updateChatRagSettingsRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatProvider, ragSettings.LLM_PROVIDER]);

  useEffect(() => {
    if (updateEmbeddingRagSettingsRef.current && embeddingProvider && embeddingProvider !== ragSettings.EMBEDDING_PROVIDER) {
      setRagSettings(prev => ({
        ...prev,
        EMBEDDING_PROVIDER: embeddingProvider
      }));
    }
    updateEmbeddingRagSettingsRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingProvider, ragSettings.EMBEDDING_PROVIDER]);

  useEffect(() => {
    if (chatProvider && ragSettings.MODEL_CHOICE && providerModels) {
      const currentSavedModel = providerModels[chatProvider]?.chatModel;
      if (currentSavedModel !== ragSettings.MODEL_CHOICE) {
        setProviderModelMutation.mutate({
          provider: chatProvider,
          modelType: 'chat',
          modelName: ragSettings.MODEL_CHOICE
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ragSettings.MODEL_CHOICE, chatProvider, providerModels]);

  useEffect(() => {
    if (embeddingProvider && ragSettings.EMBEDDING_MODEL && providerModels) {
      const currentSavedModel = providerModels[embeddingProvider]?.embeddingModel;
      if (currentSavedModel !== ragSettings.EMBEDDING_MODEL) {
        setProviderModelMutation.mutate({
          provider: embeddingProvider,
          modelType: 'embedding',
          modelName: ragSettings.EMBEDDING_MODEL
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ragSettings.EMBEDDING_MODEL, embeddingProvider, providerModels]);

  const testProviderConnection = useCallback(async (provider: string): Promise<boolean> => {
    setProviderConnectionStatus(prev => ({
      ...prev,
      [provider]: { ...prev[provider], checking: true }
    }));

    try {
      const response = await fetch(`/api/providers/${provider}/status`);
      const result = await response.json();

      const isConnected = result.ok && result.reason === 'connected';

      setProviderConnectionStatus(prev => ({
        ...prev,
        [provider]: { connected: isConnected, checking: false, lastChecked: new Date() }
      }));

      return isConnected;
    } catch (error) {
      console.error(`Error testing ${provider} connection:`, error);
      setProviderConnectionStatus(prev => ({
        ...prev,
        [provider]: { connected: false, checking: false, lastChecked: new Date() }
      }));
      return false;
    }
  }, []);

  useEffect(() => {
    const testConnections = async () => {
      const providers = ['openai', 'google', 'anthropic', 'openrouter', 'grok'];

      for (const provider of providers) {
        const lastChecked = providerConnectionStatus[provider]?.lastChecked;
        const now = new Date();
        const timeSinceLastCheck = lastChecked ? now.getTime() - lastChecked.getTime() : Infinity;

        if (timeSinceLastCheck > 30000) {
          await testProviderConnection(provider);
        }
      }
    };

    testConnections();
    const interval = setInterval(testConnections, 60000);

    return () => clearInterval(interval);
  }, [apiCredentials, testProviderConnection, providerConnectionStatus]);

  useEffect(() => {
    const handleCredentialUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: string[] }>).detail;
      const updatedKeys = (detail?.keys ?? []).map(key => key.toUpperCase());

      if (updatedKeys.length === 0) {
        void reloadApiCredentials();
        return;
      }

      const touchedProviderKeys = updatedKeys.filter(key => key in CREDENTIAL_PROVIDER_MAP);
      if (touchedProviderKeys.length === 0) {
        return;
      }

      void reloadApiCredentials();

      touchedProviderKeys.forEach(key => {
        const provider = CREDENTIAL_PROVIDER_MAP[key as ProviderCredentialKey];
        if (provider) {
          void testProviderConnection(provider);
        }
      });
    };

    window.addEventListener('archon:credentials-updated', handleCredentialUpdate);

    return () => {
      window.removeEventListener('archon:credentials-updated', handleCredentialUpdate);
    };
  }, [reloadApiCredentials, testProviderConnection]);

  const hasApiCredential = (credentialKey: ProviderCredentialKey): boolean => {
    if (credentialKey in apiCredentials) {
      return Boolean(apiCredentials[credentialKey]);
    }

    const fallbackKey = Object.keys(apiCredentials).find(
      key => key.toUpperCase() === credentialKey,
    );

    return fallbackKey ? Boolean(apiCredentials[fallbackKey]) : false;
  };

  const getProviderStatus = (providerKey: string): 'configured' | 'missing' | 'partial' => {
    switch (providerKey) {
      case 'openai':
        const hasOpenAIKey = hasApiCredential('OPENAI_API_KEY');
        const openAIConnected = providerConnectionStatus['openai']?.connected || false;
        const isChecking = providerConnectionStatus['openai']?.checking || false;

        if (!hasOpenAIKey) return 'missing';
        if (isChecking) return 'partial';
        return openAIConnected ? 'configured' : 'missing';

      case 'google':
        const hasGoogleKey = hasApiCredential('GOOGLE_API_KEY');
        const googleConnected = providerConnectionStatus['google']?.connected || false;
        const googleChecking = providerConnectionStatus['google']?.checking || false;

        if (!hasGoogleKey) return 'missing';
        if (googleChecking) return 'partial';
        return googleConnected ? 'configured' : 'missing';

      case 'ollama':
        {
          if (ollamaManualConfirmed) {
            return 'configured';
          }

          if (ollamaServerStatus === 'online') {
            return 'partial';
          }

          if (ollamaServerStatus === 'offline') {
            return 'missing';
          }

          return 'missing';
        }
      case 'anthropic':
        const hasAnthropicKey = hasApiCredential('ANTHROPIC_API_KEY');
        const anthropicConnected = providerConnectionStatus['anthropic']?.connected || false;
        const anthropicChecking = providerConnectionStatus['anthropic']?.checking || false;
        if (!hasAnthropicKey) return 'missing';
        if (anthropicChecking) return 'partial';
        return anthropicConnected ? 'configured' : 'missing';
      case 'grok':
        const hasGrokKey = hasApiCredential('GROK_API_KEY');
        const grokConnected = providerConnectionStatus['grok']?.connected || false;
        const grokChecking = providerConnectionStatus['grok']?.checking || false;
        if (!hasGrokKey) return 'missing';
        if (grokChecking) return 'partial';
        return grokConnected ? 'configured' : 'missing';
      case 'openrouter':
        const hasOpenRouterKey = hasApiCredential('OPENROUTER_API_KEY');
        const openRouterConnected = providerConnectionStatus['openrouter']?.connected || false;
        const openRouterChecking = providerConnectionStatus['openrouter']?.checking || false;
        if (!hasOpenRouterKey) return 'missing';
        if (openRouterChecking) return 'partial';
        return openRouterConnected ? 'configured' : 'missing';
      default:
        return 'missing';
    }
  };

  const resolvedProviderForAlert = activeSelection === 'chat' ? chatProvider : embeddingProvider;
  const activeProviderKey = isProviderKey(resolvedProviderForAlert)
    ? (resolvedProviderForAlert as ProviderKey)
    : undefined;
  const selectedProviderStatus = activeProviderKey ? getProviderStatus(activeProviderKey) : undefined;

  let providerAlertMessage: string | null = null;
  let providerAlertVariant: 'warning' | 'error' | null = null;

  if (activeProviderKey === 'ollama') {
    if (ollamaServerStatus === 'offline') {
      providerAlertMessage = 'Local Ollama service is not running. Start the Ollama server and ensure it is reachable at the configured URL.';
      providerAlertVariant = 'error';
    } else if (selectedProviderStatus === 'partial' && ollamaServerStatus === 'online') {
      providerAlertMessage = 'Local Ollama service detected. Click "Configure Instances" to set up your models.';
      providerAlertVariant = 'warning';
    }
  } else if (activeProviderKey && selectedProviderStatus === 'missing') {
    const providerName = providerDisplayNames[activeProviderKey] ?? activeProviderKey;
    providerAlertMessage = `${providerName} API key is not configured. Add it in Settings > API Keys.`;
    providerAlertVariant = 'error';
  }

  const shouldShowProviderAlert = Boolean(providerAlertMessage);

  if (providerModelsLoading || !providerModels) {
    return (
      <Card edgePosition="top" edgeColor="blue">
        <div className="flex items-center justify-center py-8">
          <Loader className="w-6 h-6 animate-spin text-blue-500" />
        </div>
      </Card>
    );
  }

  return (
    <Card edgePosition="top" edgeColor="blue">
      <div className="space-y-6">
        <p className="text-sm text-gray-600 dark:text-zinc-400">
          Configure AI model providers for chat and embeddings.
        </p>

        <div className="flex gap-4 mb-6 justify-center">
          <Button
            onClick={() => setActiveSelection('chat')}
            variant="ghost"
            className={`min-w-[200px] px-6 py-6 font-semibold text-white dark:text-white
              border border-emerald-400/70 dark:border-emerald-400/40
              bg-black/40 backdrop-blur-md
              shadow-[inset_0_0_16px_rgba(15,118,110,0.38)]
              hover:bg-emerald-500/12 dark:hover:bg-emerald-500/20
              hover:border-emerald-300/80 hover:shadow-[0_0_22px_rgba(16,185,129,0.5)]
              ${(activeSelection === 'chat')
                ? 'shadow-[0_0_25px_rgba(16,185,129,0.5)] ring-2 ring-emerald-400/50'
                : 'shadow-[0_0_15px_rgba(16,185,129,0.25)]'}
            `}
          >
            <span className="flex flex-col items-center gap-1 w-full min-w-0">
              <span className="flex items-center gap-2">
                <LuBrainCircuit className="w-4 h-4 text-emerald-300" aria-hidden="true" />
                <span>Chat: {chatProvider}</span>
              </span>
              <span className="text-xs text-emerald-400 font-normal truncate w-full block">
                Current: {ragSettings.MODEL_CHOICE || 'Not set'}
              </span>
            </span>
          </Button>
          <Button
            onClick={() => setActiveSelection('embedding')}
            variant="ghost"
            className={`min-w-[200px] px-6 py-6 font-semibold text-white dark:text-white
              border border-purple-400/70 dark:border-purple-400/40
              bg-black/40 backdrop-blur-md
              shadow-[inset_0_0_16px_rgba(109,40,217,0.38)]
              hover:bg-purple-500/12 dark:hover:bg-purple-500/20
              hover:border-purple-300/80 hover:shadow-[0_0_24px_rgba(168,85,247,0.52)]
              ${(activeSelection === 'embedding')
                ? 'shadow-[0_0_26px_rgba(168,85,247,0.55)] ring-2 ring-purple-400/60'
                : 'shadow-[0_0_15px_rgba(168,85,247,0.25)]'}
            `}
          >
            <span className="flex flex-col items-center gap-1 w-full min-w-0">
              <span className="flex items-center gap-2">
                <PiDatabaseThin className="w-4 h-4 text-purple-300" aria-hidden="true" />
                <span>Embed: {embeddingProvider}</span>
              </span>
              <span className="text-xs text-purple-400 font-normal truncate w-full block">
                Current: {ragSettings.EMBEDDING_MODEL || 'Not set'}
              </span>
            </span>
          </Button>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            Select {activeSelection === 'chat' ? 'Chat' : 'Embedding'} Provider
          </label>
          <div className={cn("grid gap-3 mb-4", gridCols[activeSelection])}>
            {[
              { key: 'openai', name: 'OpenAI', logo: '/img/OpenAI.png', color: 'green' },
              { key: 'google', name: 'Google', logo: '/img/google-logo.svg', color: 'blue' },
              { key: 'openrouter', name: 'OpenRouter', logo: '/img/OpenRouter.png', color: 'cyan' },
              { key: 'ollama', name: 'Ollama', logo: '/img/Ollama.png', color: 'purple' },
              { key: 'anthropic', name: 'Anthropic', logo: '/img/claude-logo.svg', color: 'orange' },
              { key: 'grok', name: 'Grok', logo: '/img/Grok.png', color: 'yellow' }
            ]
              .filter(provider =>
                activeSelection === 'chat' || EMBEDDING_CAPABLE_PROVIDERS.includes(provider.key as ProviderKey)
              )
              .map(provider => (
              <button
                key={provider.key}
                type="button"
                onClick={() => {
                  const providerKey = provider.key as ProviderKey;

                  if (activeSelection === 'chat') {
                    setChatProvider(providerKey);
                    const savedModels = providerModels[providerKey] || getDefaultModels(providerKey);
                    setRagSettings(prev => ({
                      ...prev,
                      MODEL_CHOICE: savedModels.chatModel,
                      LLM_PROVIDER: providerKey
                    }));
                    setProviderModelMutation.mutate({
                      provider: providerKey,
                      modelType: 'chat',
                      modelName: savedModels.chatModel
                    });
                  } else {
                    setEmbeddingProvider(providerKey);
                    const savedModels = providerModels[providerKey] || getDefaultModels(providerKey);
                    setRagSettings(prev => ({
                      ...prev,
                      EMBEDDING_MODEL: savedModels.embeddingModel,
                      EMBEDDING_PROVIDER: providerKey
                    }));
                    setProviderModelMutation.mutate({
                      provider: providerKey,
                      modelType: 'embedding',
                      modelName: savedModels.embeddingModel
                    });
                  }
                }}
                className={`
                  relative p-3 rounded-lg border-2 transition-all duration-200 text-center
                  ${(activeSelection === 'chat' ? chatProvider === provider.key : embeddingProvider === provider.key)
                    ? `${colorStyles[provider.key as ProviderKey]} shadow-[0_0_15px_rgba(34,197,94,0.3)]`
                    : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                  }
                  hover:scale-105 active:scale-95
                `}
              >
                <img
                  src={provider.logo}
                  alt={`${provider.name} logo`}
                  className={cn("w-8 h-8 mb-1 mx-auto", logoBackgrounds[provider.key as ProviderKey])}
                />
                <div className={cn("font-medium text-gray-700 dark:text-gray-300 text-center", providerNameFontSizes[provider.key as ProviderKey])}>
                  {provider.name}
                </div>
                {(() => {
                  const status = getProviderStatus(provider.key);

                  if (status === 'configured') {
                    return (
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    );
                  } else if (status === 'partial') {
                    return (
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-yellow-500 rounded-full flex items-center justify-center">
                        <div className="w-2 h-2 bg-white rounded-full" />
                      </div>
                    );
                  } else {
                    return (
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 bg-white rounded-full" />
                      </div>
                    );
                  }
                })()}
              </button>
            ))}
          </div>
          {shouldShowProviderAlert && providerAlertVariant && (
            <div className={cn("p-4 border rounded-lg mb-4", alertVariants[providerAlertVariant])}>
              <p className="text-sm">{providerAlertMessage}</p>
            </div>
          )}

          <div className="flex justify-between items-end gap-4">
            <div className="flex-1 max-w-md">
              {activeSelection === 'chat' ? (
                chatProvider !== 'ollama' ? (
                  <Input
                    label="Chat Model"
                    value={getDisplayedChatModel(ragSettings)}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      MODEL_CHOICE: e.target.value
                    })}
                    placeholder={getModelPlaceholder(chatProvider)}
                  />
                ) : (
                  <div className="p-3 border border-green-500/30 rounded-lg bg-green-500/5">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Chat Model
                    </label>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Configured via Ollama instance
                    </div>
                    <div className="text-xs text-green-400 mt-1 font-medium">
                      Current: {ragSettings.MODEL_CHOICE || 'Not selected'}
                    </div>
                  </div>
                )
              ) : (
                embeddingProvider !== 'ollama' ? (
                  <Input
                    label="Embedding Model"
                    value={getDisplayedEmbeddingModel(ragSettings)}
                    onChange={e => setRagSettings({
                      ...ragSettings,
                      EMBEDDING_MODEL: e.target.value
                    })}
                    placeholder={getEmbeddingPlaceholder(embeddingProvider)}
                  />
                ) : (
                  <div className="p-3 border border-purple-500/30 rounded-lg bg-purple-500/5">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Embedding Model
                    </label>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Configured via Ollama instance
                    </div>
                    <div className="text-xs text-purple-400 mt-1 font-medium">
                      Current: {ragSettings.EMBEDDING_MODEL || 'Not selected'}
                    </div>
                  </div>
                )
              )}
            </div>

            {((activeSelection === 'chat' && chatProvider === 'ollama') ||
              (activeSelection === 'embedding' && embeddingProvider === 'ollama')) && (
              <Button
                variant="outline"
                onClick={() => setShowModelsConfigDialog(true)}
              >
                <Cog className="w-4 h-4 mr-2" />
                Configure Instances
              </Button>
            )}

            {((activeSelection === 'chat' && chatProvider !== 'ollama') ||
              (activeSelection === 'embedding' && embeddingProvider !== 'ollama')) && (
              <Button
                variant="default"
                onClick={async () => {
                  try {
                    setSaving(true);

                    const provider = activeSelection === 'chat' ? chatProvider : embeddingProvider;
                    const modelName = activeSelection === 'chat'
                      ? ragSettings.MODEL_CHOICE
                      : ragSettings.EMBEDDING_MODEL;

                    await setProviderModelMutation.mutateAsync({
                      provider,
                      modelType: activeSelection,
                      modelName
                    });

                    await credentialsService.updateRagSettings({
                      ...ragSettings,
                      [activeSelection === 'chat' ? 'LLM_PROVIDER' : 'EMBEDDING_PROVIDER']: provider,
                      [activeSelection === 'chat' ? 'MODEL_CHOICE' : 'EMBEDDING_MODEL']: modelName
                    });
                  } catch (err) {
                    console.error('Failed to save model settings:', err);
                    showToast('Failed to save settings', 'error');
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving}
                loading={saving}
              >
                {!saving && <Save className="w-4 h-4 mr-2" />}
                {saving ? 'Setting...' : 'Set Model'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <ModelsConfigDialog
        open={showModelsConfigDialog}
        onOpenChange={setShowModelsConfigDialog}
      />
    </Card>
  );
};
