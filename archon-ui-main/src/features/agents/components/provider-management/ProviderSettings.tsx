/**
 * Provider Settings Component
 *
 * Manages API keys for the clean provider system
 * Shows only active providers with option to add more
 */

import React, { useState, useEffect } from "react";
import { Key, Loader2, Plus, Shield } from "lucide-react";
import { useToast } from "../../../../contexts/ToastContext";
import { cleanProviderService } from "../../../../services/cleanProviderService";
import type {
  ProviderType,
  ProviderStatus,
  ProviderMetadata,
} from "../../../../types/cleanProvider";
import { Button } from "../../../../components/ui/Button";
import { AddProviderModal } from "./AddProviderModal";
import { useAgents } from "../../hooks";
import { ProviderCard } from "./ProviderCard";

interface ProviderSettingsProps {
  onProviderAdded?: () => void;
}

export const ProviderSettings: React.FC<ProviderSettingsProps> = React.memo(
  ({ onProviderAdded }) => {
    const [allProviders, setAllProviders] = useState<string[]>([]);
    const [activeProviders, setActiveProviders] = useState<ProviderStatus[]>(
      []
    );
    const [providersMetadata, setProvidersMetadata] = useState<
      Record<string, ProviderMetadata>
    >({});
    const [loading, setLoading] = useState(true);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const { showToast } = useToast();

    // Use optimistic update hooks
    const {
      addProvider,
      removeProvider,
      testProvider,
      isAddingProvider,
      isRemovingProvider,
      isTestingProvider,
    } = useAgents();

    // Load provider status on mount
    useEffect(() => {
      loadProviders();
    }, []);

    const loadProviders = async () => {
      try {
        setLoading(true);
        // Get all available providers and statuses
        let allProviderList: string[] = [];
        try {
          allProviderList = await cleanProviderService.getAllProviders();
        } catch (e) {
          console.warn("Failed to fetch all providers, using empty list:", e);
          allProviderList = [];
        }

        const providerStatuses =
          await cleanProviderService.getAllProviderStatuses();
        // Provider metadata is optional; handle 404 as empty object
        let metadata: Record<string, ProviderMetadata> = {} as any;
        try {
          metadata = await cleanProviderService.getProvidersMetadata();
        } catch (e) {
          console.warn(
            "Failed to fetch provider metadata, using empty object:",
            e
          );
          metadata = {} as any;
        }

        // Filter to only show configured providers
        const configuredProviders = providerStatuses.filter(
          (p) => p.configured
        );
        setActiveProviders(configuredProviders);
        setProvidersMetadata(metadata);

        // Get list of unconfigured providers
        const configuredNames = configuredProviders.map((p) => p.provider);
        const unconfiguredProviders = allProviderList.filter(
          (p) => !configuredNames.includes(p)
        );
        setAllProviders(unconfiguredProviders);
      } catch (error) {
        console.error("Failed to load providers:", error);
        showToast(
          error instanceof Error
            ? `Failed to load provider information: ${error.message}`
            : "Failed to load provider information",
          "error"
        );
        // Set empty states on error to prevent UI crashes
        setActiveProviders([]);
        setProvidersMetadata({});
        setAllProviders([]);
      } finally {
        setLoading(false);
      }
    };

    const handleSaveApiKey = async (
      provider: ProviderType,
      apiKey: string,
      baseUrl?: string
    ) => {
      try {
        // Use optimistic add provider mutation
        await addProvider({ provider, apiKey, baseUrl });
        showToast("Provider added successfully", "success");
      } catch (error) {
        console.error("Failed to add provider:", error);
        showToast(
          error instanceof Error
            ? `Failed to add provider: ${error.message}`
            : "Failed to add provider",
          "error"
        );
      }
    };

    const handleTestConnection = async (provider: ProviderType) => {
      try {
        // Use optimistic test provider mutation
        await testProvider({ provider });
        showToast("Provider connection tested successfully", "success");
      } catch (error) {
        console.error("Failed to test provider connection:", error);
        showToast(
          error instanceof Error
            ? `Failed to test connection: ${error.message}`
            : "Failed to test provider connection",
          "error"
        );
      }
    };

    const handleRemoveApiKey = async (provider: ProviderType) => {
      try {
        // Use optimistic remove provider mutation
        await removeProvider({ provider });
        showToast("Provider removed successfully", "success");
      } catch (error) {
        console.error("Failed to remove provider:", error);
        showToast(
          error instanceof Error
            ? `Failed to remove provider: ${error.message}`
            : "Failed to remove provider",
          "error"
        );
      }
    };

    if (loading) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-light text-white">
              Provider Configuration
            </h3>
            <p className="text-sm text-gray-400 mt-1">
              {activeProviders.length === 0
                ? "No providers configured yet"
                : `${activeProviders.length} active provider${
                    activeProviders.length === 1 ? "" : "s"
                  }`}
            </p>
          </div>

          <Button
            onClick={() => setIsAddModalOpen(true)}
            variant="primary"
            size="sm"
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add Provider
          </Button>
        </div>

        {/* Active Providers */}
        {activeProviders.length > 0 ? (
          <div className="space-y-4 p-2">
            {activeProviders.map((provider) => (
              <ProviderCard
                key={provider.provider}
                provider={provider}
                metadata={providersMetadata[provider.provider]}
                onSave={handleSaveApiKey}
                onTest={handleTestConnection}
                onRemove={handleRemoveApiKey}
                isSaving={isAddingProvider}
                isTesting={isTestingProvider}
                isRemoving={isRemovingProvider}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 rounded-xl border border-zinc-800/50 bg-zinc-900/20">
            <Key className="w-12 h-12 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400 text-sm mb-4">
              No providers configured yet
            </p>
            <p className="text-gray-500 text-xs mb-6 max-w-md mx-auto">
              Add a provider to start using AI models. You can configure
              multiple providers and switch between them based on your needs.
            </p>
          </div>
        )}

        {/* Security Info Box */}
        {activeProviders.length > 0 && (
          <div
            className="relative rounded-xl p-4 mt-6"
            style={{
              background:
                "linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)",
              backdropFilter: "blur(10px)",
            }}
          >
            <div
              className="absolute inset-0 rounded-xl p-[1px] pointer-events-none"
              style={{
                background:
                  "linear-gradient(180deg, rgba(59, 130, 246, 0.2) 0%, rgba(59, 130, 246, 0.05) 100%)",
              }}
            >
              <div
                className="w-full h-full rounded-xl"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)",
                }}
              />
            </div>

            <div className="relative flex gap-3">
              <Shield className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-gray-400">
                <p className="font-medium text-blue-400 mb-1">Secure Storage</p>
                <p className="leading-relaxed">
                  API keys are encrypted with Fernet encryption and stored
                  securely in your database. They are never exposed in the
                  frontend and only used server-side for AI model requests.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Add Provider Modal */}
        <AddProviderModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          onProviderAdded={async () => {
            try {
              await loadProviders();
              // Also notify parent component if callback provided
              if (onProviderAdded) {
                onProviderAdded();
              }
            } catch (error) {
              console.error("Failed to refresh providers after adding:", error);
              showToast(
                error instanceof Error
                  ? `Failed to refresh providers: ${error.message}`
                  : "Failed to refresh provider list",
                "error"
              );
            }
          }}
          existingProviders={activeProviders.map((p) => p.provider)}
          providersMetadata={providersMetadata}
          availableProviders={allProviders}
        />
      </div>
    );
  }
);
