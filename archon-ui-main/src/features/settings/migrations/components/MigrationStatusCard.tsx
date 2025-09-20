/**
 * Card component showing migration status
 */

import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle, Database, RefreshCw } from "lucide-react";
import React from "react";
import { useMigrationStatus } from "../hooks/useMigrationQueries";
import { PendingMigrationsModal } from "./PendingMigrationsModal";

export function MigrationStatusCard() {
  const { data, isLoading, error, refetch } = useMigrationStatus();
  const [isModalOpen, setIsModalOpen] = React.useState(false);

  const handleRefresh = () => {
    refetch();
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="bg-gray-900/50 border border-gray-700 rounded-lg p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-purple-400" />
            <h3 className="text-white font-semibold">Database Migrations</h3>
          </div>
          <button type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            className="p-2 hover:bg-gray-700/50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Refresh migration status"
          >
            <RefreshCw className={`w-4 h-4 text-gray-400 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-sm">Applied Migrations</span>
            <span className="text-white font-mono text-sm">{data?.applied_count ?? 0}</span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-sm">Pending Migrations</span>
            <div className="flex items-center gap-2">
              <span className="text-white font-mono text-sm">{data?.pending_count ?? 0}</span>
              {data && data.pending_count > 0 && <AlertTriangle className="w-4 h-4 text-yellow-400" />}
            </div>
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
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  <span className="text-red-400 text-sm">Error loading</span>
                </>
              ) : data?.bootstrap_required ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-yellow-400" />
                  <span className="text-yellow-400 text-sm">Setup required</span>
                </>
              ) : data?.has_pending ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-yellow-400" />
                  <span className="text-yellow-400 text-sm">Migrations pending</span>
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  <span className="text-green-400 text-sm">Up to date</span>
                </>
              )}
            </div>
          </div>

          {data?.current_version && (
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm">Database Version</span>
              <span className="text-white font-mono text-sm">{data.current_version}</span>
            </div>
          )}
        </div>

        {data?.has_pending && (
          <div className="mt-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <p className="text-yellow-400 text-sm mb-2">
              {data.bootstrap_required
                ? "Initial database setup is required."
                : `${data.pending_count} migration${data.pending_count > 1 ? "s" : ""} need to be applied.`}
            </p>
            <button type="button"
              onClick={() => setIsModalOpen(true)}
              className="px-3 py-1.5 bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/50 rounded text-yellow-400 text-sm font-medium transition-colors"
            >
              View Pending Migrations
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-red-400 text-sm">
              Failed to load migration status. Please check your database connection.
            </p>
          </div>
        )}
      </motion.div>

      {/* Modal for viewing pending migrations */}
      {data && (
        <PendingMigrationsModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          migrations={data.pending_migrations}
          onMigrationsApplied={refetch}
        />
      )}
    </>
  );
}
