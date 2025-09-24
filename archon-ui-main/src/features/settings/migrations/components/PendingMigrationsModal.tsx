/**
 * Modal for viewing and copying pending migration SQL
 */

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle, Copy, Database, ExternalLink, X } from "lucide-react";
import React from "react";
import { copyToClipboard } from "@/features/shared/utils/clipboard";
import { useToast } from "@/features/shared/hooks/useToast";
import type { PendingMigration } from "../types";

interface PendingMigrationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  migrations: PendingMigration[];
  onMigrationsApplied: () => void;
}

export function PendingMigrationsModal({
  isOpen,
  onClose,
  migrations,
  onMigrationsApplied,
}: PendingMigrationsModalProps) {
  const { showToast } = useToast();
  const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null);
  const [expandedIndex, setExpandedIndex] = React.useState<number | null>(null);

  const handleCopy = async (sql: string, index: number) => {
    const result = await copyToClipboard(sql);
    if (result.success) {
      setCopiedIndex(index);
      showToast("SQL copied to clipboard", "success");
      setTimeout(() => setCopiedIndex(null), 2000);
    } else {
      showToast("Failed to copy SQL", "error");
    }
  };

  const handleCopyAll = async () => {
    const allSql = migrations.map((m) => `-- ${m.name}\n${m.sql_content}`).join("\n\n");
    const result = await copyToClipboard(allSql);
    if (result.success) {
      showToast("All migration SQL copied to clipboard", "success");
    } else {
      showToast("Failed to copy SQL", "error");
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />

        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2 }}
          className="relative bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-700">
            <div className="flex items-center gap-3">
              <Database className="w-6 h-6 text-purple-400" />
              <h2 className="text-xl font-semibold text-white">Pending Database Migrations</h2>
            </div>
            <button type="button" onClick={onClose} className="p-2 hover:bg-gray-700/50 rounded-lg transition-colors">
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Instructions */}
          <div className="p-6 bg-blue-500/10 border-b border-gray-700">
            <h3 className="text-blue-400 font-medium mb-2 flex items-center gap-2">
              <ExternalLink className="w-4 h-4" />
              How to Apply Migrations
            </h3>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside">
              <li>Copy the SQL for each migration below</li>
              <li>Open your Supabase dashboard SQL Editor</li>
              <li>Paste and execute each migration in order</li>
              <li>Click "Refresh Status" below to verify migrations were applied</li>
            </ol>
            {migrations.length > 1 && (
              <button type="button"
                onClick={handleCopyAll}
                className="mt-3 px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 rounded text-blue-400 text-sm font-medium transition-colors"
              >
                Copy All Migrations
              </button>
            )}
          </div>

          {/* Migration List */}
          <div className="overflow-y-auto max-h-[calc(80vh-280px)] p-6 pb-8">
            {migrations.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
                <p className="text-gray-300">All migrations have been applied!</p>
              </div>
            ) : (
              <div className="space-y-4 pb-4">
                {migrations.map((migration, index) => (
                  <div
                    key={`${migration.version}-${migration.name}`}
                    className="bg-gray-800/50 border border-gray-700 rounded-lg"
                  >
                    <div className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <h4 className="text-white font-medium">{migration.name}</h4>
                          <p className="text-gray-400 text-sm mt-1">
                            Version: {migration.version} • {migration.file_path}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button type="button"
                            onClick={() => handleCopy(migration.sql_content, index)}
                            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium text-gray-300 flex items-center gap-2 transition-colors"
                          >
                            {copiedIndex === index ? (
                              <>
                                <CheckCircle className="w-4 h-4 text-green-400" />
                                Copied!
                              </>
                            ) : (
                              <>
                                <Copy className="w-4 h-4" />
                                Copy SQL
                              </>
                            )}
                          </button>
                          <button type="button"
                            onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
                            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium text-gray-300 transition-colors"
                          >
                            {expandedIndex === index ? "Hide" : "Show"} SQL
                          </button>
                        </div>
                      </div>

                      {/* SQL Content */}
                      <AnimatePresence>
                        {expandedIndex === index && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <pre className="mt-3 p-3 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 overflow-x-auto">
                              <code>{migration.sql_content}</code>
                            </pre>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-gray-700 flex justify-between">
            <button type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300 font-medium transition-colors"
            >
              Close
            </button>
            <button type="button"
              onClick={onMigrationsApplied}
              className="px-4 py-2 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/50 rounded-lg text-purple-400 font-medium transition-colors"
            >
              Refresh Status
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
