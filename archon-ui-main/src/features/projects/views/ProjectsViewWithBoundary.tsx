import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { FeatureErrorBoundary } from "../../ui/components";
import { ProjectsView } from "./ProjectsView";

export const ProjectsViewWithBoundary = () => {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <FeatureErrorBoundary featureName="Projects" onReset={reset}>
          <ProjectsView />
        </FeatureErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
