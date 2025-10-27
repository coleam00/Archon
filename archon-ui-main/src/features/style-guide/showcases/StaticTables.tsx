export const StaticTables = () => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Tables</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Table styles with glassmorphism and hover states</p>
      </div>

      {/* Standard Table - matching TaskView pattern */}
      <div>
        <h3 className="text-sm font-semibold mb-3 text-gray-800 dark:text-gray-200">Standard Table</h3>
        <div className="w-full">
          <div className="overflow-x-auto scrollbar-hide">
            <table className="w-full">
              <thead>
                <tr className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 border-b-2 border-gray-200 dark:border-gray-700">
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Name</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Status</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Count</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Date</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-white/50 dark:bg-black/50 hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70 dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20 border-b border-gray-200 dark:border-gray-800 transition-all duration-200">
                  <td className="px-4 py-2">
                    <span className="font-medium text-sm text-gray-900 dark:text-white">React Documentation</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-1 text-xs rounded-md font-medium bg-green-500/10 text-green-600 dark:text-green-400">
                      Active
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">145</td>
                  <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">2024-01-15</td>
                </tr>
                <tr className="bg-gray-50/80 dark:bg-gray-900/30 hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70 dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20 border-b border-gray-200 dark:border-gray-800 transition-all duration-200">
                  <td className="px-4 py-2">
                    <span className="font-medium text-sm text-gray-900 dark:text-white">API Integration</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-1 text-xs rounded-md font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                      Processing
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">89</td>
                  <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">2024-01-18</td>
                </tr>
                <tr className="bg-white/50 dark:bg-black/50 hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70 dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20 border-b border-gray-200 dark:border-gray-800 transition-all duration-200">
                  <td className="px-4 py-2">
                    <span className="font-medium text-sm text-gray-900 dark:text-white">TypeScript Guide</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-1 text-xs rounded-md font-medium bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                      Complete
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">203</td>
                  <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">2024-01-20</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
          Features: Gradient header, alternating rows, hover gradient, consistent spacing
        </p>
      </div>
    </div>
  );
};
