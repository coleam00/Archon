import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { FeatureErrorBoundary } from "../../ui/components";
import { McpView } from "./McpView";

export const McpViewWithBoundary = () => {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <FeatureErrorBoundary featureName="MCP Dashboard" onReset={reset}>
          <McpView />
        </FeatureErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
