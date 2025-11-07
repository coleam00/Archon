/**
 * Workflow Transform Utilities
 *
 * Converts between WorkflowStep[] format and React Flow nodes/edges format.
 * Handles node positioning, sub-step extraction, and edge creation.
 */

import type { Node, Edge } from "@xyflow/react";
import type { WorkflowStep, StepTemplate, AgentTemplate } from "../../types";
import type { TypeNodeData } from "./TypeNode";
import type { TemplateSelectorNodeData } from "./TemplateSelectorNode";
import type { TemplateNodeData } from "./TemplateNode";
import type { SubStepNodeData } from "./SubStepNode";
import type { GitNodeData } from "./GitNode";
import type { PlusIconNodeData } from "./PlusIconNode";
import type { DiamondAddNodeData } from "./DiamondAddNode";

// Node positioning constants
const TYPE_NODE_X_SPACING = 300;
const TYPE_NODE_Y = 100;
const PLUS_ICON_Y_OFFSET = 80; // Plus icon below type node
const TEMPLATE_NODE_Y_OFFSET = 140; // Template node below plus icon
const DIAMOND_ADD_Y_OFFSET = 50; // Spacing between templates for diamond add nodes
const SUBSTEP_NODE_Y_OFFSET = 50;
const SUBSTEP_NODE_X_OFFSET = 30;

/**
 * Convert WorkflowStep[] to React Flow nodes and edges
 */
export function workflowStepsToNodes(
  steps: WorkflowStep[],
  stepTemplates?: StepTemplate[],
  agentTemplates?: AgentTemplate[]
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Group steps by type
  const stepsByType: Record<string, WorkflowStep[]> = {
    planning: [],
    implement: [],
    validate: [],
    prime: [],
    git: [],
  };

  steps.forEach((step) => {
    if (step.step_type in stepsByType) {
      stepsByType[step.step_type].push(step);
    }
  });

  // Create type nodes for planning, implement, validate (always create these)
  const typeNodes: Array<{ type: "planning" | "implement" | "validate"; x: number }> = [
    { type: "planning", x: 100 },
    { type: "implement", x: 100 + TYPE_NODE_X_SPACING },
    { type: "validate", x: 100 + TYPE_NODE_X_SPACING * 2 },
  ];

  let nodeIdCounter = 1;

  typeNodes.forEach((typeNodeConfig) => {
    const typeNodeId = `type-${typeNodeConfig.type}`;
    const typeSteps = stepsByType[typeNodeConfig.type];

    // Create type node
    nodes.push({
      id: typeNodeId,
      type: "typeNode",
      position: { x: typeNodeConfig.x, y: TYPE_NODE_Y },
      data: {
        stepType: typeNodeConfig.type,
        label: typeNodeConfig.type.charAt(0).toUpperCase() + typeNodeConfig.type.slice(1),
      } as TypeNodeData,
    });

    // Always create a plus icon node below the type node
    const plusIconNodeId = `plus-${typeNodeConfig.type}`;
    nodes.push({
      id: plusIconNodeId,
      type: "plusIconNode",
      position: { x: typeNodeConfig.x, y: TYPE_NODE_Y + PLUS_ICON_Y_OFFSET },
      data: {
        stepType: typeNodeConfig.type,
      } as PlusIconNodeData,
    });

    // Connect type node bottom to plus icon with dashed line
    edges.push({
      id: `edge-${typeNodeId}-${plusIconNodeId}`,
      source: typeNodeId,
      sourceHandle: "bottom",
      target: plusIconNodeId,
      type: "smoothstep",
      style: { stroke: "#9ca3af", strokeWidth: 1, strokeDasharray: "5,5" },
    });

    // Create template nodes below plus icon if steps exist
    if (typeSteps.length > 0) {
      // Use the first step of this type (for now, one template per type)
      const step = typeSteps[0];
      const template = stepTemplates?.find((t) => t.slug === step.step_template_slug);

      if (template) {
        // Create filled template node
        const templateNodeId = `template-${nodeIdCounter++}`;
        nodes.push({
          id: templateNodeId,
          type: "templateNode",
          position: { x: typeNodeConfig.x, y: TYPE_NODE_Y + TEMPLATE_NODE_Y_OFFSET },
          data: {
            templateName: template.name,
            templateSlug: template.slug,
            hasSubSteps: template.sub_steps.length > 0,
            subStepCount: template.sub_steps.length,
          } as TemplateNodeData,
        });

        // Connect plus icon to template node with dashed line
        edges.push({
          id: `edge-${plusIconNodeId}-${templateNodeId}`,
          source: plusIconNodeId,
          target: templateNodeId,
          type: "smoothstep",
          style: { stroke: "#9ca3af", strokeWidth: 1, strokeDasharray: "5,5" },
        });

        // Create sub-step nodes if template has sub_steps
        if (template.sub_steps.length > 0) {
          template.sub_steps
            .sort((a, b) => a.order - b.order)
            .forEach((subStep, index) => {
              const agentTemplate = agentTemplates?.find((a) => a.slug === subStep.agent_template_slug);
              const subStepNodeId = `substep-${nodeIdCounter++}`;
              nodes.push({
                id: subStepNodeId,
                type: "subStepNode",
                position: {
                  x: typeNodeConfig.x + SUBSTEP_NODE_X_OFFSET,
                  y: TYPE_NODE_Y + TEMPLATE_NODE_Y_OFFSET + (index + 1) * SUBSTEP_NODE_Y_OFFSET,
                },
                data: {
                  subStepName: subStep.name,
                  agentName: agentTemplate?.name || subStep.agent_template_slug,
                  order: subStep.order,
                } as SubStepNodeData,
              });

              // Connect template node to sub-step node with dashed edge
              edges.push({
                id: `edge-${templateNodeId}-${subStepNodeId}`,
                source: templateNodeId,
                target: subStepNodeId,
                type: "smoothstep",
                style: { stroke: "#9ca3af", strokeWidth: 1, strokeDasharray: "5,5" },
              });
            });
        }
      }
    }
  });

  // Create edges between type nodes (planning -> implement -> validate)
  if (typeNodes.length > 1) {
    for (let i = 0; i < typeNodes.length - 1; i++) {
      const sourceId = `type-${typeNodes[i].type}`;
      const targetId = `type-${typeNodes[i + 1].type}`;
      edges.push({
        id: `edge-${sourceId}-${targetId}`,
        source: sourceId,
        target: targetId,
        type: "smoothstep",
        style: { stroke: "#22d3ee", strokeWidth: 3 },
        animated: true,
      });
    }
  }

  // Handle Git and Prime steps (positioned before/after type nodes)
  const gitSteps = stepsByType.git;
  const primeSteps = stepsByType.prime;

  // For now, position Git steps before planning
  gitSteps.forEach((step, index) => {
    const gitNodeId = `git-${nodeIdCounter++}`;
    const gitOperation = step.step_template_slug as "create-branch" | "commit" | "pull-request";
    nodes.push({
      id: gitNodeId,
      type: "gitNode",
      position: { x: 50, y: TYPE_NODE_Y + index * 80 },
      data: {
        operation: gitOperation,
        label: gitOperation === "create-branch" ? "Create Branch" : gitOperation === "commit" ? "Commit" : "Pull Request",
      } as GitNodeData,
    });
  });

  return { nodes, edges };
}

/**
 * Convert React Flow nodes/edges to WorkflowStep[]
 */
export function nodesToWorkflowSteps(nodes: Node[]): WorkflowStep[] {
  const steps: WorkflowStep[] = [];

  // Extract template nodes and their associated type
  const templateNodes = nodes.filter((n) => n.type === "templateNode");
  const typeNodes = nodes.filter((n) => n.type === "typeNode");

  templateNodes.forEach((templateNode) => {
    // Find the type node above this template node
    const typeNode = typeNodes.find((tn) => {
      const typeY = tn.position.y;
      const templateY = templateNode.position.y;
      const typeX = tn.position.x;
      const templateX = templateNode.position.x;
      // Check if template is below type and roughly aligned
      return templateY > typeY && Math.abs(templateX - typeX) < 50;
    });

    if (typeNode && templateNode.data) {
      const templateData = templateNode.data as TemplateNodeData;
      const typeData = typeNode.data as TypeNodeData;

      steps.push({
        step_type: typeData.stepType,
        order: steps.length + 1,
        step_template_slug: templateData.templateSlug,
      });
    }
  });

  // Extract Git nodes
  const gitNodes = nodes.filter((n) => n.type === "gitNode");
  gitNodes.forEach((gitNode) => {
    if (gitNode.data) {
      const gitData = gitNode.data as GitNodeData;
      steps.push({
        step_type: "git",
        order: steps.length + 1,
        step_template_slug: gitData.operation,
      });
    }
  });

  // Sort by order (based on x position for type nodes, or explicit order)
  return steps.sort((a, b) => {
    const orderMap: Record<string, number> = {
      planning: 1,
      implement: 2,
      validate: 3,
      git: 0, // Git steps go first
      prime: 0.5,
    };
    return (orderMap[a.step_type] || 999) - (orderMap[b.step_type] || 999);
  });
}

