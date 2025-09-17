import { Layout } from "lucide-react";
import { Toggle } from "../../../components/ui/Toggle";
import { ProjectsView } from "./ProjectsView";

interface ProjectsViewWithToggleProps {
  useSidebarLayout?: boolean;
  onToggleLayout?: () => void;
}

export function ProjectsViewWithToggle({
  useSidebarLayout = false,
  onToggleLayout
}: ProjectsViewWithToggleProps) {
  return (
    <div className="relative">
      {/* Toggle Button - Fixed Position */}
      {onToggleLayout && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 bg-white dark:bg-gray-800 p-3 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
          <span className="text-sm text-gray-600 dark:text-gray-400 hidden sm:inline">
            Sidebar Layout
          </span>
          <Toggle
            checked={useSidebarLayout}
            onCheckedChange={onToggleLayout}
            accentColor="purple"
            icon={<Layout className="w-4 h-4" />}
          />
        </div>
      )}

      {/* Original ProjectsView */}
      <ProjectsView />
    </div>
  );
}