export interface NormalizedCredential {
  key: string;
  value?: string;
  encrypted_value?: string | null;
  is_encrypted?: boolean;
  category: string;
}

export interface ProviderInfo {
  provider?: string;
}

/**
 * Determines if LM (Language Model) is configured based on credentials
 * 
 * Logic:
 * - provider := value of 'LLM_PROVIDER' from ragCreds (if present)
 * - if provider === 'openai': check for valid OPENAI_API_KEY
 * - if provider === 'google' or 'gemini': check for valid GOOGLE_API_KEY
 * - if provider === 'ollama': return true (local, no API key needed)
 * - if no provider: check for any valid API key (OpenAI or Google)
 */
export function isLmConfigured(
  ragCreds: NormalizedCredential[],
  apiKeyCreds: NormalizedCredential[]
): boolean {
  // Find the LLM_PROVIDER setting from RAG credentials
  const providerCred = ragCreds.find(c => c.key === 'LLM_PROVIDER');
  const provider = providerCred?.value?.toLowerCase();

  // Debug logging
  console.log('🔎 isLmConfigured - Provider:', provider);
  console.log('🔎 isLmConfigured - API Keys:', apiKeyCreds.map(c => ({
    key: c.key,
    value: c.value,
    encrypted_value: c.encrypted_value,
    is_encrypted: c.is_encrypted,
    hasValidValue: !!(c.value && c.value !== 'null' && c.value !== null)
  })));

  // Helper function to check if a credential has a valid value
  const hasValidCredential = (cred: NormalizedCredential | undefined): boolean => {
    if (!cred) return false;
    // If is_encrypted is true, we consider it valid even without a value,
    // as the value is stored on the server.
    if (cred.is_encrypted) return true;

    return !!(cred.value && cred.value !== 'null' && cred.value !== null && cred.value.trim() !== '');
  };

  // Find API keys
  const openAIKeyCred = apiKeyCreds.find(c => c.key.toUpperCase() === 'OPENAI_API_KEY');
  const googleKeyCred = apiKeyCreds.find(c => c.key.toUpperCase() === 'GOOGLE_API_KEY');
  
  const hasOpenAIKey = hasValidCredential(openAIKeyCred);
  const hasGoogleKey = hasValidCredential(googleKeyCred);

  console.log('🔎 isLmConfigured - OpenAI key valid:', hasOpenAIKey);
  console.log('🔎 isLmConfigured - Google key valid:', hasGoogleKey);

  // Check based on provider
  if (provider === 'openai') {
    // OpenAI provider requires OpenAI API key
    return hasOpenAIKey;
  } else if (provider === 'google' || provider === 'gemini') {
    // Google/Gemini provider requires Google API key
    return hasGoogleKey;
  } else if (provider === 'ollama') {
    // Ollama is local, doesn't need API key
    return true;
  } else if (provider) {
    // Unknown provider, assume it doesn't need an API key
    console.log('🔎 isLmConfigured - Unknown provider, assuming configured:', provider);
    return true;
  } else {
    // No provider specified, check if ANY API key is configured
    // This allows users to configure either OpenAI or Google without specifying provider
    return hasOpenAIKey || hasGoogleKey;
  }
}