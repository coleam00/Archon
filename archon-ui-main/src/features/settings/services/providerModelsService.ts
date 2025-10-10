import { credentialsService } from '../../../services/credentialsService';

export type ProviderKey = 'openai' | 'google' | 'ollama' | 'anthropic' | 'grok' | 'openrouter';

export interface ProviderModels {
  chatModel: string;
  embeddingModel: string;
}

export type ProviderModelMap = Record<ProviderKey, ProviderModels>;

const getDefaultModels = (provider: ProviderKey): ProviderModels => {
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

export const providerModelsService = {
  async loadProviderModels(): Promise<ProviderModelMap & { ollamaChatUrl?: string; ollamaEmbeddingUrl?: string }> {
    try {
      const credentials = await credentialsService.getCredentialsByCategory('model_settings');

      const providers: ProviderKey[] = ['openai', 'google', 'openrouter', 'ollama', 'anthropic', 'grok'];
      const modelMap: any = {};

      providers.forEach(provider => {
        const chatKey = `PROVIDER_${provider.toUpperCase()}_CHAT_MODEL`;
        const embeddingKey = `PROVIDER_${provider.toUpperCase()}_EMBEDDING_MODEL`;

        const chatCred = credentials.find(c => c.key === chatKey);
        const embeddingCred = credentials.find(c => c.key === embeddingKey);

        const defaults = getDefaultModels(provider);

        modelMap[provider] = {
          chatModel: chatCred?.value || defaults.chatModel,
          embeddingModel: embeddingCred?.value || defaults.embeddingModel
        };
      });

      const ollamaChatUrlCred = credentials.find(c => c.key === 'OLLAMA_CHAT_HOST_URL');
      const ollamaEmbeddingUrlCred = credentials.find(c => c.key === 'OLLAMA_EMBEDDING_HOST_URL');

      modelMap.ollamaChatUrl = ollamaChatUrlCred?.value || 'http://host.docker.internal:11434/v1';
      modelMap.ollamaEmbeddingUrl = ollamaEmbeddingUrlCred?.value || 'http://host.docker.internal:11434/v1';

      return modelMap;
    } catch (error) {
      console.error('Failed to load provider models from database:', error);

      const providers: ProviderKey[] = ['openai', 'google', 'openrouter', 'ollama', 'anthropic', 'grok'];
      const defaultModels: any = {};

      providers.forEach(provider => {
        defaultModels[provider] = getDefaultModels(provider);
      });

      defaultModels.ollamaChatUrl = 'http://host.docker.internal:11434/v1';
      defaultModels.ollamaEmbeddingUrl = 'http://host.docker.internal:11434/v1';

      return defaultModels;
    }
  },

  async saveProviderModel(
    provider: ProviderKey,
    modelType: 'chat' | 'embedding',
    modelName: string,
    ollamaHostUrl?: string
  ): Promise<void> {
    const promises: Promise<any>[] = [];

    const key = `PROVIDER_${provider.toUpperCase()}_${modelType.toUpperCase()}_MODEL`;
    promises.push(
      credentialsService.createCredential({
        key,
        value: modelName,
        is_encrypted: false,
        category: 'model_settings',
        description: `${modelType} model for ${provider} provider`
      })
    );

    if (provider === 'ollama' && ollamaHostUrl) {
      const urlKey = `OLLAMA_${modelType.toUpperCase()}_HOST_URL`;
      promises.push(
        credentialsService.createCredential({
          key: urlKey,
          value: ollamaHostUrl,
          is_encrypted: false,
          category: 'model_settings',
          description: `Ollama ${modelType} host URL`
        })
      );

      const ragUrlKey = modelType === 'chat' ? 'LLM_BASE_URL' : 'OLLAMA_EMBEDDING_URL';
      promises.push(
        credentialsService.createCredential({
          key: ragUrlKey,
          value: ollamaHostUrl,
          is_encrypted: false,
          category: 'rag_strategy',
          description: `Active ${modelType} model URL (backward compatibility)`
        })
      );
    }

    await Promise.all(promises);
  },

  async updateProviderModels(providerModels: ProviderModelMap): Promise<void> {
    const promises: Promise<any>[] = [];

    Object.entries(providerModels).forEach(([provider, models]) => {
      const providerKey = provider as ProviderKey;

      promises.push(
        this.saveProviderModel(providerKey, 'chat', models.chatModel),
        this.saveProviderModel(providerKey, 'embedding', models.embeddingModel)
      );
    });

    await Promise.all(promises);
  },
};
