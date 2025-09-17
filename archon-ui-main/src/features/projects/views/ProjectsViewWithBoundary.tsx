import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { useState } from "react";
import { FeatureErrorBoundary } from "../../ui/components";
import { Button } from "../../ui/primitives";
import { ProjectsView } from "./ProjectsView";
import { ProjectsViewSidebar } from "./ProjectsViewSidebar";

export const ProjectsViewWithBoundary = () => {
  // Feature flag to toggle between old and new layouts
  // In a real app, this would come from a settings/feature flag service
  const [useSidebarLayout, setUseSidebarLayout] = useState(false);

  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <FeatureErrorBoundary featureName="Projects" onReset={reset}>
          {/* Layout Toggle (temporary for development) */}
          <div className="fixed top-4 right-4 z-50 bg-white dark:bg-gray-800 p-2 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
            <Button
              variant={useSidebarLayout ? "default" : "outline"}
              size="sm"
              onClick={() => setUseSidebarLayout(!useSidebarLayout)}
              className="text-xs"
            >
              {useSidebarLayout ? "New Layout" : "Old Layout"}
            </Button>
          </div>

          {/* Render appropriate layout */}
          {useSidebarLayout ? <ProjectsViewSidebar /> : <ProjectsView />}
        </FeatureErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
