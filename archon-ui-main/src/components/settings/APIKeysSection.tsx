import { useState, useEffect } from "react";
import { Lock, Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { cleanProviderService } from "../../services/cleanProviderService";
import { useToast } from "../../contexts/ToastContext";
import type { ProviderType } from "../../types/cleanProvider";

export const APIKeysSection = () => {
  const [providers, setProviders] = useState<ProviderType[] | null>(null);
  const [isLoadingProviders, setIsLoadingProviders] = useState(true);
  const [providerKey, setProviderKey] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<ProviderType | null>(
    null
  );
  const [isBootstrapping, setIsBootstrapping] = useState(false);

  const { showToast } = useToast();

  // Load providers on mount
  useEffect(() => {
    loadProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProviders = async () => {
    try {
      setIsLoadingProviders(true);
      const list = await cleanProviderService.getProviders();
      setProviders(list);
      if (list.length > 0 && !selectedProvider) setSelectedProvider(list[0]);
    } catch (err: unknown) {
      // If 404, providers table is empty
      setProviders([]);
    } finally {
      setIsLoadingProviders(false);
    }
  };

  const handleBootstrapProviders = async () => {
    try {
      setIsBootstrapping(true);
      await cleanProviderService.bootstrap(true);
      showToast("Providers bootstrapped successfully", "success");
      // Refresh providers list
      await loadProviders();
    } catch (err: unknown) {
      console.error("Failed to bootstrap providers", err);
      showToast("Failed to bootstrap providers", "error");
    } finally {
      setIsBootstrapping(false);
    }
  };

  const handleSetProviderKey = async () => {
    if (!selectedProvider || !providerKey) {
      showToast("Select a provider and enter an API key", "error");
      return;
    }
    try {
      await cleanProviderService.setApiKey(selectedProvider, providerKey);
      showToast(
        `API key saved for ${selectedProvider}. Syncing models...`,
        "success"
      );
      setProviderKey("");
      // Refresh providers list after saving key
      await loadProviders();
    } catch (err: unknown) {
      console.error("Failed to set provider key", err);
      showToast("Failed to set provider key", "error");
    }
  };

  return (
    <Card accentColor="pink" className="p-8">
      <div className="space-y-6">
        {/* Providers quick add */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
              Providers
            </h3>
            {isLoadingProviders ? (
              <span className="text-xs text-gray-500">Loading…</span>
            ) : providers && providers.length === 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">
                  No providers found
                </span>
                <Button
                  size="sm"
                  onClick={handleBootstrapProviders}
                  disabled={isBootstrapping}
                >
                  {isBootstrapping ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Bootstrapping...
                    </>
                  ) : (
                    "Bootstrap Providers"
                  )}
                </Button>
              </div>
            ) : null}
          </div>
          {providers && providers.length > 0 && (
            <div className="flex gap-2 items-center">
              <select
                value={selectedProvider || ""}
                onChange={(e) =>
                  setSelectedProvider(e.target.value as ProviderType)
                }
                className="px-3 py-2 rounded-md bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm"
                aria-label="Select AI provider"
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                type="password"
                placeholder="Enter API key"
                value={providerKey}
                onChange={(e) => setProviderKey(e.target.value)}
                className="flex-1 px-3 py-2 rounded-md bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm"
              />
              <Button onClick={handleSetProviderKey}>Save Key</Button>
            </div>
          )}
        </div>

        {/* Description text */}
        <p className="text-sm text-gray-600 dark:text-zinc-400 mb-4">
          Manage your API keys for AI providers. Select a provider above and
          enter your API key to enable that service.
        </p>

        {/* Provider Status Section */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">
            Provider Status
          </h4>
          {providers && providers.length > 0 ? (
            <div className="grid gap-2">
              {providers.map((provider) => (
                <div
                  key={provider}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-md border border-gray-200 dark:border-gray-700"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                      <span className="text-white text-xs font-bold uppercase">
                        {provider.charAt(0)}
                      </span>
                    </div>
                    <div>
                      <span className="text-sm font-medium capitalize text-gray-900 dark:text-white">
                        {provider}
                      </span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        API key configured
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                      <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                        Active
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                No providers configured yet
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Add an API key above to get started with AI providers
              </p>
            </div>
          )}
        </div>

        {/* Security Notice */}
        <div className="p-3 mt-6 mb-2 bg-gray-50 dark:bg-black/40 rounded-md flex items-start gap-3">
          <div className="w-5 h-5 text-pink-500 mt-0.5 flex-shrink-0">
            <Lock className="w-5 h-5" />
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">
            <p>
              API keys are encrypted and stored securely. They are only
              decrypted when needed for API calls.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
};
