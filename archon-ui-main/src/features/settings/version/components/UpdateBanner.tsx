/**
 * Banner component that shows when an update is available
 */

import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpCircle, ExternalLink, X } from "lucide-react";
import React from "react";
import { useVersionCheck } from "../hooks/useVersionQueries";

export function UpdateBanner() {
  const { data, isLoading, error } = useVersionCheck();
  const [isDismissed, setIsDismissed] = React.useState(false);

  // Don't show banner if loading, error, no data, or no update available
  if (isLoading || error || !data?.update_available || isDismissed) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
        className="bg-gradient-to-r from-blue-500/20 to-purple-500/20 border border-blue-500/30 rounded-lg p-4 mb-6"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ArrowUpCircle className="w-6 h-6 text-blue-400 animate-pulse" />
            <div>
              <h3 className="text-white font-semibold">Update Available: v{data.latest}</h3>
              <p className="text-gray-400 text-sm mt-1">You are currently running v{data.current}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data.release_url && (
              <a
                href={data.release_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 rounded-lg text-blue-400 transition-all duration-200"
              >
                <span className="text-sm font-medium">View Release</span>
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <a
              href="https://github.com/coleam00/Archon#upgrading"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/50 rounded-lg text-purple-400 transition-all duration-200"
            >
              <span className="text-sm font-medium">View Upgrade Instructions</span>
              <ExternalLink className="w-4 h-4" />
            </a>
            <button type="button"
              onClick={() => setIsDismissed(true)}
              className="p-2 hover:bg-gray-700/50 rounded-lg transition-colors"
              aria-label="Dismiss update banner"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
