import React from 'react';
import { AlertCircle, Terminal, RefreshCw } from 'lucide-react';

export const BackendStartupError: React.FC = () => {
  const handleRetry = () => {
    // Reload the page to retry
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-[10000] bg-black/90 backdrop-blur-sm flex items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        <div className="bg-red-950/50 border-2 border-red-500/50 rounded-lg p-8 shadow-2xl backdrop-blur-md">
          <div className="flex items-start gap-4">
            <AlertCircle className="w-8 h-8 text-red-500 flex-shrink-0 mt-1" />
            <div className="space-y-4 flex-1">
              <h2 className="text-2xl font-bold text-red-100">
                Backend Service Startup Failure
              </h2>
              
              <p className="text-red-200">
                The Archon backend service failed to start. This is typically due to a configuration issue.
              </p>

              <div className="bg-black/50 rounded-lg p-4 border border-red-900/50">
                <div className="flex items-center gap-2 mb-3 text-red-300">
                  <Terminal className="w-5 h-5" />
                  <span className="font-semibold">Check Docker Logs</span>
                </div>
                <p className="text-red-100 font-mono text-sm mb-3">
                  Check the <span className="text-red-400 font-bold">Archon API server</span> container logs in Docker Desktop for detailed error information.
                </p>
                <div className="space-y-2 text-xs text-red-300">
                  <p>1. Open Docker Desktop</p>
                  <p>2. Go to Containers tab</p>
                  <p>3. Look for the Archon server container (typically named <span className="text-red-400 font-semibold">archon-server</span> or similar)</p>
                  <p>4. View the logs for the specific error message</p>
                </div>
              </div>

              <div className="bg-yellow-950/30 border border-yellow-700/30 rounded-lg p-3">
                <p className="text-yellow-200 text-sm">
                  <strong>Common issues:</strong>
                </p>
                <ul className="text-yellow-200 text-sm mt-1 space-y-1 list-disc list-inside">
                  <li>Using an ANON key instead of SERVICE key in your .env file</li>
                  <li>Database not set up - run <code className="bg-yellow-800/50 px-1 rounded">migration/complete_setup.sql</code> in Supabase SQL Editor</li>
                </ul>
              </div>

              <div className="pt-4 border-t border-red-900/30">
                <p className="text-red-300 text-sm">
                  After fixing the issue in your .env file, recreate the Docker containers:
                </p>
                <code className="block mt-2 p-2 bg-black/70 rounded text-red-100 font-mono text-sm">
                  docker compose down && docker compose up --build -d
                </code>
                <div className="text-red-300 text-xs mt-2">
                  <p>Note:</p>
                  <p>• Use 'down' and 'up' (not 'restart') so new env vars are picked up.</p>
                  <p>• If you originally started with a specific profile (backend, frontend, or full),</p>
                  <p>&nbsp;&nbsp;run the same profile again:</p>
                  <br />
                  <code className="bg-black/50 px-1 rounded">docker compose --profile full up --build -d</code>
                </div>
              </div>

              <div className="flex justify-center pt-4">
                <button
                  onClick={handleRetry}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 border border-red-500/50 rounded-lg text-red-100 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Retry Connection
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};