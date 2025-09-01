import React from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Card } from './Card';

interface MigrationBannerProps {
  message: string;
  onDismiss?: () => void;
}

export const MigrationBanner: React.FC<MigrationBannerProps> = ({
  message,
  onDismiss
}) => {
  return (
    <Card className="bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800 mb-6">
      <div className="flex items-start gap-3 p-4">
        <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-red-800 dark:text-red-300 mb-2">
            Database Migration Required
          </h3>
          <p className="text-red-700 dark:text-red-400 mb-3">
            {message}
          </p>
          <div className="bg-red-100 dark:bg-red-900/40 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-3">
            <p className="text-sm font-medium text-red-800 dark:text-red-300 mb-2">
              Follow these steps:
            </p>
            <ol className="text-sm text-red-700 dark:text-red-400 space-y-1 list-decimal list-inside">
              <li>Open your Supabase project dashboard</li>
              <li>Navigate to the SQL Editor</li>
              <li>Copy and run the migration script from: <code className="bg-red-200 dark:bg-red-800 px-1 rounded">migration/add_source_url_display_name.sql</code></li>
              <li>Restart Docker containers: <code className="bg-red-200 dark:bg-red-800 px-1 rounded">docker compose down && docker compose up --build -d</code></li>
              <li>If you used a profile, add it: <code className="bg-red-200 dark:bg-red-800 px-1 rounded">--profile full</code></li>
            </ol>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://supabase.com/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Open Supabase Dashboard
            </a>
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 text-sm font-medium"
              >
                Dismiss (temporarily)
              </button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
};