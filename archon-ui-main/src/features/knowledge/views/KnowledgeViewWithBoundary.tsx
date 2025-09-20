import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { FeatureErrorBoundary } from "../../ui/components";
import { KnowledgeFilterProvider } from "../context";
import { KnowledgeView } from "./KnowledgeView";

export const KnowledgeViewWithBoundary = () => {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <FeatureErrorBoundary featureName="Knowledge Base" onReset={reset}>
          <KnowledgeFilterProvider>
            <KnowledgeView />
          </KnowledgeFilterProvider>
        </FeatureErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
