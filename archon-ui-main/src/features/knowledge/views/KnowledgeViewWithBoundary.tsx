import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { FeatureErrorBoundary } from "../../ui/components";
import { KnowledgeView } from "./KnowledgeView";

export const KnowledgeViewWithBoundary = () => {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <FeatureErrorBoundary featureName="Knowledge Base" onReset={reset}>
          <KnowledgeView />
        </FeatureErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
