import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { useState } from "react";
import { FeatureErrorBoundary } from "../../ui/components";
import { ProjectsViewSidebar } from "./ProjectsViewSidebar";
import { ProjectsViewWithToggle } from "./ProjectsViewWithToggle";

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
            <ProjectsViewWithToggle
              useSidebarLayout={useSidebarLayout}
              onToggleLayout={() => setUseSidebarLayout(!useSidebarLayout)}
            />
          )}
        </FeatureErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
