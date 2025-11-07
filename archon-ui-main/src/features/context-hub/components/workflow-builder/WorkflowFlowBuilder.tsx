/**
 * Workflow Flow Builder Component
 *
 * Main React Flow component for visual workflow building.
 * Replaces the list-based WorkflowBuilder with a node-based visual editor.
 */

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
} from "@xyflow/react";
import { useStepTemplates } from "../../hooks/useStepTemplates";
import { useAgentTemplates } from "../../hooks/useAgentTemplates";
import type { WorkflowStep, StepTemplate } from "../../types";
import { workflowStepsToNodes, nodesToWorkflowSteps } from "./workflowTransform";
import { nodeTypes } from "./nodeTypes";
import { NodePalette, type PaletteNode } from "./NodePalette";
import { TemplateSelector } from "./TemplateSelector";
import type { TemplateSelectorNodeData } from "./TemplateSelectorNode";

interface WorkflowFlowBuilderProps {
  steps: WorkflowStep[];
  onChange: (steps: WorkflowStep[]) => void;
  disabled?: boolean;
}

export function WorkflowFlowBuilder({ steps, onChange, disabled = false }: WorkflowFlowBuilderProps) {
  // Fetch all step templates and agent templates
  const { data: allStepTemplates } = useStepTemplates(undefined, true, true);
  const { data: agentTemplates } = useAgentTemplates(true, true);

  // State for template selector
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedStepType, setSelectedStepType] = useState<"planning" | "implement" | "validate" | "prime" | "git">("planning");

  // Convert workflow steps to React Flow nodes/edges
  const initialNodesAndEdges = useMemo(() => {
    return workflowStepsToNodes(steps, allStepTemplates, agentTemplates);
  }, [steps, allStepTemplates, agentTemplates]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodesAndEdges.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialNodesAndEdges.edges);

  // Update nodes/edges when steps change externally (but avoid infinite loops)
  useEffect(() => {
    if (!allStepTemplates) return; // Wait for templates to load
    
    const { nodes: newNodes, edges: newEdges } = workflowStepsToNodes(steps, allStepTemplates, agentTemplates);
    setNodes(newNodes);
    setEdges(newEdges);
  }, [steps, allStepTemplates, agentTemplates, setNodes, setEdges]);

  // Handle node click for template selection
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (disabled) return;

      if (node.type === "templateSelectorNode" || node.type === "plusIconNode" || node.type === "diamondAddNode") {
        const data = node.data as TemplateSelectorNodeData | { stepType: "planning" | "implement" | "validate" };
        setSelectedNodeId(node.id);
        setSelectedStepType(data.stepType);
        setSelectorOpen(true);
      }
    },
    [disabled]
  );

  // Handle template selection
  const handleTemplateSelect = useCallback(
    (template: StepTemplate) => {
      if (!selectedNodeId) return;

      setNodes((nds) => {
        const clickedNode = nds.find((n) => n.id === selectedNodeId);
        if (!clickedNode) return nds;

        // If clicking a plus icon or diamond add node, create a new template node below it
        if (clickedNode.type === "plusIconNode" || clickedNode.type === "diamondAddNode") {
          const templateNodeId = `template-${Date.now()}`;
          const templateNode: Node = {
            id: templateNodeId,
            type: "templateNode",
            position: {
              x: clickedNode.position.x,
              y: clickedNode.position.y + 60, // Position below the plus icon
            },
            data: {
              templateName: template.name,
              templateSlug: template.slug,
              hasSubSteps: template.sub_steps.length > 0,
              subStepCount: template.sub_steps.length,
            },
          };

          // Create edge from plus icon to template node
          const newEdge: Edge = {
            id: `edge-${selectedNodeId}-${templateNodeId}`,
            source: selectedNodeId,
            target: templateNodeId,
            type: "smoothstep",
            style: { stroke: "#9ca3af", strokeWidth: 1, strokeDasharray: "5,5" },
          };

          setEdges((eds) => [...eds, newEdge]);

          // If template has sub-steps, create sub-step nodes
          if (template.sub_steps.length > 0 && agentTemplates) {
            const newSubStepNodes: Node[] = template.sub_steps
              .sort((a, b) => a.order - b.order)
              .map((subStep, index) => {
                const agentTemplate = agentTemplates.find((a) => a.slug === subStep.agent_template_slug);
                return {
                  id: `substep-${Date.now()}-${index}`,
                  type: "subStepNode",
                  position: {
                    x: templateNode.position.x + 30,
                    y: templateNode.position.y + (index + 1) * 50,
                  },
                  data: {
                    subStepName: subStep.name,
                    agentName: agentTemplate?.name || subStep.agent_template_slug,
                    order: subStep.order,
                  },
                };
              });

            const newSubStepEdges: Edge[] = newSubStepNodes.map((subStepNode) => ({
              id: `edge-${templateNodeId}-${subStepNode.id}`,
              source: templateNodeId,
              target: subStepNode.id,
              type: "smoothstep",
              style: { stroke: "#9ca3af", strokeWidth: 1, strokeDasharray: "5,5" },
            }));

            setEdges((eds) => [...eds, ...newSubStepEdges]);
            return [...nds, templateNode, ...newSubStepNodes];
          }

          return [...nds, templateNode];
        }

        // Otherwise, replace selector node with template node (legacy behavior)
        const updatedNodes = nds.map((node) => {
          if (node.id === selectedNodeId) {
            return {
              ...node,
              type: "templateNode",
              data: {
                templateName: template.name,
                templateSlug: template.slug,
                hasSubSteps: template.sub_steps.length > 0,
                subStepCount: template.sub_steps.length,
              },
            };
          }
          return node;
        });

        // If template has sub-steps, create sub-step nodes
        if (template.sub_steps.length > 0 && agentTemplates) {
          const templateNode = updatedNodes.find((n) => n.id === selectedNodeId);
          if (templateNode) {
            const newSubStepNodes: Node[] = template.sub_steps
              .sort((a, b) => a.order - b.order)
              .map((subStep, index) => {
                const agentTemplate = agentTemplates.find((a) => a.slug === subStep.agent_template_slug);
                return {
                  id: `substep-${Date.now()}-${index}`,
                  type: "subStepNode",
                  position: {
                    x: templateNode.position.x + 30,
                    y: templateNode.position.y + (index + 1) * 50,
                  },
                  data: {
                    subStepName: subStep.name,
                    agentName: agentTemplate?.name || subStep.agent_template_slug,
                    order: subStep.order,
                  },
                };
              });

            const newSubStepEdges: Edge[] = newSubStepNodes.map((subStepNode) => ({
              id: `edge-${selectedNodeId}-${subStepNode.id}`,
              source: selectedNodeId,
              target: subStepNode.id,
              type: "smoothstep",
              style: { stroke: "#9ca3af", strokeWidth: 1, strokeDasharray: "5,5" },
            }));

            setEdges((eds) => [...eds, ...newSubStepEdges]);
            return [...updatedNodes, ...newSubStepNodes];
          }
        }

        return updatedNodes;
      });

      // Update workflow steps after nodes are updated
      setTimeout(() => {
        setNodes((currentNodes) => {
          const newSteps = nodesToWorkflowSteps(currentNodes);
          onChange(newSteps);
          return currentNodes;
        });
      }, 0);

      setSelectorOpen(false);
      setSelectedNodeId(null);
    },
    [selectedNodeId, agentTemplates, setNodes, setEdges, onChange]
  );

  // Handle adding nodes from palette
  const handleAddNode = useCallback(
    (paletteNode: PaletteNode) => {
      if (disabled) return;

      // For type nodes (planning, implement, validate), they should already exist
      // For Git nodes, add them
      if (paletteNode.type === "git" && paletteNode.gitOperation) {
        const gitNode: Node = {
          id: `git-${Date.now()}`,
          type: "gitNode",
          position: { x: 50, y: 100 },
          data: {
            operation: paletteNode.gitOperation,
            label:
              paletteNode.gitOperation === "create-branch"
                ? "Create Branch"
                : paletteNode.gitOperation === "commit"
                  ? "Commit"
                  : "Pull Request",
          },
        };

        setNodes((nds) => [...nds, gitNode]);
      }
    },
    [disabled, setNodes]
  );

  // Handle edge connections
  const onConnect = useCallback(
    (params: Connection) => {
      if (disabled) return;
      setEdges((eds) => addEdge(params, eds));
    },
    [disabled, setEdges]
  );

  // Note: We don't auto-update steps from nodes here to avoid infinite loops
  // Steps are updated explicitly when templates are selected or nodes are added

  return (
    <div className="flex flex-col h-full">
      <NodePalette onAddNode={handleAddNode} disabled={disabled} />
      <div className="flex-1 relative" style={{ minHeight: "500px" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          className="bg-transparent"
        >
          <Background className="bg-gray-500/5" />
          <Controls
            className="!bg-gray-800/90 dark:!bg-gray-900/90 !border-gray-700 dark:!border-gray-600"
            style={{
              button: {
                backgroundColor: "rgba(31, 41, 55, 0.9)",
                borderColor: "rgba(75, 85, 99, 1)",
                color: "#e5e7eb",
              },
            }}
          />
          <MiniMap
            className="!bg-gray-800/90 dark:!bg-gray-900/90 !border-gray-700 dark:!border-gray-600"
            nodeColor={(node) => {
              if (node.type === "typeNode") return "#a855f7";
              if (node.type === "templateNode") return "#3b82f6";
              return "#6b7280";
            }}
            maskColor="rgba(0, 0, 0, 0.3)"
          />
        </ReactFlow>
      </div>
      <TemplateSelector
        open={selectorOpen}
        onOpenChange={setSelectorOpen}
        stepType={selectedStepType}
        onSelect={handleTemplateSelect}
      />
    </div>
  );
}

