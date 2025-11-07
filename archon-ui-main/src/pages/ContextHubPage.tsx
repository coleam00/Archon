/**
 * Context Hub Page
 *
 * Main page for Context Engineering Hub - template library management.
 * Provides tabbed interface for agents, steps, workflows, and coding standards.
 */

import { Brain } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/features/ui/primitives/tabs";
import { useContextHubStore } from "@/features/context-hub/state/contextHubStore";
import { AgentLibraryView } from "@/features/context-hub/views/AgentLibraryView";
import { StepLibraryView } from "@/features/context-hub/views/StepLibraryView";
import { WorkflowLibraryView } from "@/features/context-hub/views/WorkflowLibraryView";
import { CodingStandardsView } from "@/features/context-hub/views/CodingStandardsView";
import type { ContextHubTab } from "@/features/context-hub/types";

export function ContextHubPage() {
  const activeTab = useContextHubStore((s) => s.activeTab);
  const setActiveTab = useContextHubStore((s) => s.setActiveTab);

  const handleTabChange = (value: string) => {
    setActiveTab(value as ContextHubTab);
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      {/* Page Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-indigo-500/20">
            <Brain className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              Context Engineering Hub
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Template library for workflows, agents, steps, and coding standards
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="mb-6">
          <TabsTrigger value="agents" color="blue">
            Agents
          </TabsTrigger>
          <TabsTrigger value="steps" color="green">
            Steps
          </TabsTrigger>
          <TabsTrigger value="workflows" color="purple">
            Workflows
          </TabsTrigger>
          <TabsTrigger value="standards" color="cyan">
            Standards
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents">
          <AgentLibraryView />
        </TabsContent>

        <TabsContent value="steps">
          <StepLibraryView />
        </TabsContent>

        <TabsContent value="workflows">
          <WorkflowLibraryView />
        </TabsContent>

        <TabsContent value="standards">
          <CodingStandardsView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
