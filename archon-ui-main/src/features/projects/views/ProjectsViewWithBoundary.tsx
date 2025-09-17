import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { useState } from "react";
import { FeatureErrorBoundary } from "../../ui/components";
import { ProjectsView } from "./ProjectsView";
import { ProjectsViewSidebar } from "./ProjectsViewSidebar";

export const ProjectsViewWithBoundary = () => {
  // Feature flag to toggle between old and new layouts
  // In a real app, this would come from a settings/feature flag service
  const [useSidebarLayout, setUseSidebarLayout] = useState(true);

  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <FeatureErrorBoundary featureName="Projects" onReset={reset}>
          {/* Render appropriate layout */}
          {useSidebarLayout ? (
            <ProjectsViewSidebar
              useSidebarLayout={useSidebarLayout}
              onToggleLayout={() => setUseSidebarLayout(!useSidebarLayout)}
            />
          ) : (
            <ProjectsView />
          )}
        </FeatureErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
