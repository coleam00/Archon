/**
 * Card component showing current version status
 */

import { motion } from "framer-motion";
import { AlertCircle, CheckCircle, Info, RefreshCw } from "lucide-react";
import { useClearVersionCache, useVersionCheck } from "../hooks/useVersionQueries";

export function VersionStatusCard() {
  const { data, isLoading, error, refetch } = useVersionCheck();
  const clearCache = useClearVersionCache();

  const handleRefreshClick = async () => {
    // Clear cache and then refetch
    await clearCache.mutateAsync();
    refetch();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-gray-900/50 border border-gray-700 rounded-lg p-6"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Info className="w-5 h-5 text-blue-400" />
          <h3 className="text-white font-semibold">Version Information</h3>
        </div>
        <button
          type="button"
          onClick={handleRefreshClick}
          disabled={isLoading || clearCache.isPending}
          className="p-2 hover:bg-gray-700/50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Refresh version check"
        >
          <RefreshCw className={`w-4 h-4 text-gray-400 ${isLoading || clearCache.isPending ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-gray-400 text-sm">Current Version</span>
          <span className="text-white font-mono text-sm">{data?.current || "Loading..."}</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-gray-400 text-sm">Latest Version</span>
          <span className="text-white font-mono text-sm">
            {isLoading ? "Checking..." : error ? "Check failed" : data?.latest ? data.latest : "No releases found"}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-gray-400 text-sm">Status</span>
          <div className="flex items-center gap-2">
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 text-blue-400 animate-spin" />
                <span className="text-blue-400 text-sm">Checking...</span>
              </>
            ) : error ? (
              <>
                <AlertCircle className="w-4 h-4 text-red-400" />
                <span className="text-red-400 text-sm">Error checking</span>
              </>
            ) : data?.update_available ? (
              <>
                <AlertCircle className="w-4 h-4 text-yellow-400" />
                <span className="text-yellow-400 text-sm">Update available</span>
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 text-green-400" />
                <span className="text-green-400 text-sm">Up to date</span>
              </>
            )}
          </div>
        </div>

        {data?.published_at && (
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-sm">Released</span>
            <span className="text-gray-300 text-sm">{new Date(data.published_at).toLocaleDateString()}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-red-400 text-sm">
            {data?.check_error || "Failed to check for updates. Please try again later."}
          </p>
        </div>
      )}
    </motion.div>
  );
}
