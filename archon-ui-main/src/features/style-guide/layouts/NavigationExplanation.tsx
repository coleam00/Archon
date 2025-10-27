import { ChevronRight } from "lucide-react";

export const NavigationExplanation = () => {
  return (
    <div className="space-y-8">
      {/* Navigation Hierarchy at Top */}
      <div className="bg-white/80 dark:bg-black/40 border border-gray-300 dark:border-gray-700 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Navigation Hierarchy</h3>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="px-3 py-1 bg-cyan-500/20 text-cyan-700 dark:text-cyan-400 rounded border border-cyan-400/30 font-medium">
            Main Nav
          </span>
          <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          <span className="px-3 py-1 bg-purple-500/20 text-purple-700 dark:text-purple-400 rounded border border-purple-400/30 font-medium">
            Content Area
          </span>
          <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          <span className="px-3 py-1 bg-blue-500/20 text-blue-700 dark:text-blue-400 rounded border border-blue-400/30 font-medium">
            Page Tabs
          </span>
          <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          <span className="px-3 py-1 bg-green-500/20 text-green-700 dark:text-green-400 rounded border border-green-400/30 font-medium">
            View Controls
          </span>
        </div>
      </div>

      {/* Wireframe Mockup */}
      <div className="relative h-[500px]">
        {/* Main Navigation - Floating Left (Centered Vertically) */}
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[72px] flex flex-col items-center gap-2">
          <div className="text-xs font-semibold text-cyan-700 dark:text-cyan-400">Main Navigation</div>
          <div className="w-full h-[250px] bg-cyan-200 dark:bg-cyan-900/30 rounded-lg border-2 border-cyan-500/50 flex items-center justify-center p-2">
            <span className="text-[10px] text-cyan-700 dark:text-cyan-400 text-center">Floating</span>
          </div>
        </div>

        {/* Content Area - Full Width (with left padding for nav) */}
        <div className="pl-20 h-full flex flex-col gap-2">
          <div className="text-xs font-semibold text-purple-700 dark:text-purple-400">Content Area</div>
          <div className="flex-1 bg-purple-100 dark:bg-purple-900/20 rounded-lg border-2 border-purple-500/50 p-4 space-y-3">
            {/* Page Tabs - Pill Shaped */}
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-blue-700 dark:text-blue-400">
                Page Navigation (Pill Tabs)
              </div>
              <div className="h-10 w-48 mx-auto bg-blue-200 dark:bg-blue-900/30 rounded-full border-2 border-blue-500/50 flex items-center justify-center">
                <span className="text-xs text-blue-700 dark:text-blue-400">Docs | Tasks</span>
              </div>
            </div>

            {/* View Controls */}
            <div className="flex items-center justify-end gap-2">
              <div className="text-[10px] font-semibold text-green-700 dark:text-green-400">View Controls</div>
              <div className="h-8 w-20 bg-green-200 dark:bg-green-900/30 rounded-lg border-2 border-green-500/50 flex items-center justify-center">
                <span className="text-xs text-green-700 dark:text-green-400">Grid/List</span>
              </div>
            </div>

            {/* Content Placeholder */}
            <div className="flex-1 bg-gray-200 dark:bg-gray-800 rounded-lg border-2 border-gray-400 dark:border-gray-600 flex items-center justify-center">
              <span className="text-sm text-gray-600 dark:text-gray-400">Page Content</span>
            </div>
          </div>
        </div>
      </div>

      {/* Key Point */}
      <div className="bg-orange-100 dark:bg-orange-500/10 border border-orange-400/50 rounded-lg p-4">
        <p className="text-sm text-gray-800 dark:text-gray-200">
          <strong className="text-orange-700 dark:text-orange-400">Important:</strong> Main navigation is OUTSIDE the
          content area (fixed position). All page layouts (including sidebar variants) exist INSIDE the content area and
          use relative positioning to avoid overlapping with the main nav.
        </p>
      </div>
    </div>
  );
};
