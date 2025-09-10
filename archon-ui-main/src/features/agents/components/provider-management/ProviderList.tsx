/**
 * Provider List Component
 *
 * Displays available providers with search and filtering functionality
 * Refactored to use shared provider utilities
 */

import React, { useMemo } from "react";
import {
  Search,
  X,
  Info,
  CheckCircle,
  AlertCircle,
  DollarSign,
} from "lucide-react";
import { Badge } from "../../../../components/ui/Badge";
import type { ProviderMetadata } from "../../../../types/cleanProvider";
import { getProviderDisplayInfo } from "../common";

interface ProviderListProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  availableProviders: string[];
  existingProviders: string[];
  providersMetadata: Record<string, ProviderMetadata>;
  onSelectProvider: (provider: string) => void;
}

export const ProviderList: React.FC<ProviderListProps> = ({
  searchQuery,
  onSearchChange,
  availableProviders,
  existingProviders,
  providersMetadata,
  onSelectProvider,
}) => {
  // Using shared provider display utilities

  // Filter available providers based on backend metadata
  const filteredProviders = useMemo(() => {
    // Only use providers from the database - no hardcoded fallbacks
    const allProviderKeys = availableProviders || [];

    if (!searchQuery) return allProviderKeys;

    const query = searchQuery.toLowerCase();
    return allProviderKeys.filter((key) => {
      const metadata = providersMetadata[key];
      const info = getProviderDisplayInfo(key, metadata);

      // Search in provider name, description
      return (
        key.toLowerCase().includes(query) ||
        info.name.toLowerCase().includes(query) ||
        (info.description || "").toLowerCase().includes(query) ||
        (metadata?.provider || "").toLowerCase().includes(query)
      );
    });
  }, [searchQuery, providersMetadata, availableProviders]);

  return (
    <div className="space-y-4">
      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search providers..."
          className="w-full pl-10 pr-10 py-2 text-sm bg-zinc-800 text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
            title="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Provider Selection */}
      <div>
        {/* Show info if some providers are already configured */}
        {existingProviders.length > 0 && (
          <div className="mb-3 p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
            <p className="text-xs text-blue-400">
              <Info className="w-3 h-3 inline mr-1" />
              Configured providers are shown but disabled. Manage them in the
              main provider list.
            </p>
          </div>
        )}

        <div className="space-y-3 max-h-96 overflow-y-auto">
          {filteredProviders.length > 0 ? (
            filteredProviders.map((key) => {
              const metadata = providersMetadata[key]; // Backend metadata (models, costs, etc)
              const info = getProviderDisplayInfo(key, metadata); // Generated display info
              const isConfigured = existingProviders.includes(key);

              return (
                <div
                  key={key}
                  className={`w-full p-4 rounded-lg border transition-all text-left ${
                    isConfigured
                      ? "border-emerald-900/50 bg-emerald-950/20"
                      : "border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{info.icon}</span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className={`font-medium ${info.color}`}>
                          {info.name}
                        </h3>
                        {isConfigured && (
                          <Badge variant="success" className="text-xs">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            Configured
                          </Badge>
                        )}
                        {!isConfigured && metadata && (
                          <Badge variant="secondary" className="text-xs">
                            {metadata.model_count} models
                          </Badge>
                        )}
                      </div>

                      {/* Use generated description from metadata */}
                      <p className="text-xs text-gray-400 mb-2">
                        {info.description}
                      </p>

                      {/* Show backend metadata features */}
                      {!isConfigured && metadata && (
                        <div className="space-y-2">
                          {/* Feature badges */}
                          <div className="flex flex-wrap gap-1">
                            {metadata.has_free_models && (
                              <Badge variant="success" size="sm">
                                Free Models
                              </Badge>
                            )}
                            {metadata.supports_vision && (
                              <Badge variant="primary" size="sm">
                                Vision
                              </Badge>
                            )}
                            {metadata.supports_tools && (
                              <Badge variant="secondary" size="sm">
                                Tools/Functions
                              </Badge>
                            )}
                            {metadata.max_context_length > 100000 && (
                              <Badge variant="warning" size="sm">
                                {Math.floor(metadata.max_context_length / 1000)}
                                K Context
                              </Badge>
                            )}
                          </div>

                          {/* Cost range */}
                          {metadata.min_input_cost > 0 && (
                            <div className="text-xs text-gray-500">
                              <DollarSign className="w-3 h-3 inline mr-1" />$
                              {metadata.min_input_cost.toFixed(4)} - $
                              {metadata.max_input_cost.toFixed(2)}/1M tokens
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {!isConfigured && (
                      <button
                        onClick={() => onSelectProvider(key)}
                        className="px-3 py-1 text-xs bg-purple-600/20 text-purple-400 rounded hover:bg-purple-600/30 transition-colors"
                        title="Configure this provider"
                      >
                        Configure
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-center py-8">
              <AlertCircle className="w-12 h-12 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400">
                No providers found matching your search
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
