import { useState, useEffect, useRef } from 'react';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';
import type { Edge } from '@xyflow/react';
import { hasCycle } from '@/lib/dag-layout';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  field?: string;
  suggestion?: string;
}

const SEVERITY_ORDER: Record<ValidationIssue['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function getInstantIssues(
  workflowName: string,
  workflowDescription: string,
  nodes: DagFlowNode[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!workflowName.trim()) {
    issues.push({
      severity: 'error',
      message: 'Workflow name is required',
      field: 'name',
    });
  }

  if (!workflowDescription.trim()) {
    issues.push({
      severity: 'error',
      message: 'Workflow description is required',
      field: 'description',
    });
  }

  if (nodes.length === 0) {
    issues.push({
      severity: 'error',
      message: 'At least one node is required',
    });
  }

  for (const node of nodes) {
    const { id } = node.data;
    switch (node.data.nodeType) {
      case 'bash':
        if (!node.data.bashScript?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": bash script cannot be empty`,
            nodeId: id,
            field: 'bashScript',
            suggestion: 'Enter a bash script for this node',
          });
        }
        break;
      case 'prompt':
        if (!node.data.promptText?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": prompt cannot be empty`,
            nodeId: id,
            field: 'promptText',
            suggestion: 'Enter a prompt for this node',
          });
        }
        break;
      case 'command':
        if (!node.data.label.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": command name is required`,
            nodeId: id,
            field: 'command',
            suggestion: 'Pick a command from the dropdown',
          });
        }
        break;
      case 'script':
        if (!node.data.scriptBody?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": script cannot be empty`,
            nodeId: id,
            field: 'scriptBody',
          });
        }
        if (!node.data.scriptRuntime) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": script runtime ('bun' or 'uv') is required`,
            nodeId: id,
            field: 'scriptRuntime',
          });
        }
        break;
      case 'loop': {
        const loop = node.data.loopConfig;
        if (!loop?.prompt?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": loop.prompt is required`,
            nodeId: id,
            field: 'loopConfig.prompt',
          });
        }
        if (!loop?.until?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": loop.until completion signal is required`,
            nodeId: id,
            field: 'loopConfig.until',
          });
        }
        if (!loop?.max_iterations || loop.max_iterations < 1) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": loop.max_iterations must be a positive integer`,
            nodeId: id,
            field: 'loopConfig.max_iterations',
          });
        }
        if (loop?.interactive && !loop?.gate_message?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": interactive loop requires gate_message`,
            nodeId: id,
            field: 'loopConfig.gate_message',
          });
        }
        if (node.data.retry) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": retry is not supported on loop nodes`,
            nodeId: id,
            field: 'retry',
            suggestion: 'Loop nodes manage their own iteration',
          });
        }
        break;
      }
      case 'approval': {
        const approval = node.data.approvalConfig;
        if (!approval?.message?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": approval.message is required`,
            nodeId: id,
            field: 'approvalConfig.message',
          });
        }
        if (approval?.on_reject && !approval.on_reject.prompt?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": approval.on_reject.prompt cannot be empty`,
            nodeId: id,
            field: 'approvalConfig.on_reject.prompt',
          });
        }
        break;
      }
      case 'cancel':
        if (!node.data.cancelReason?.trim()) {
          issues.push({
            severity: 'error',
            message: `Node "${id}": cancel reason cannot be empty`,
            nodeId: id,
            field: 'cancelReason',
          });
        }
        break;
    }
  }

  return issues;
}

function getDebouncedIssues(nodes: DagFlowNode[], edges: Edge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(nodes.map(n => n.data.id));

  // 1. Duplicate node IDs
  const idCounts = new Map<string, number>();
  for (const node of nodes) {
    const id = node.data.id;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push({
        severity: 'error',
        message: `Duplicate node ID "${id}" (appears ${count} times)`,
        nodeId: id,
        field: 'id',
        suggestion: 'Each node must have a unique ID',
      });
    }
  }

  // 2. Broken depends_on (missing source or target)
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      issues.push({
        severity: 'error',
        message: `Edge references non-existent source node "${edge.source}"`,
        nodeId: edge.target,
        field: 'depends_on',
      });
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        severity: 'error',
        message: `Edge references non-existent target node "${edge.target}"`,
        nodeId: edge.source,
        field: 'depends_on',
      });
    }
  }

  // 3. Self-loops
  for (const edge of edges) {
    if (edge.source === edge.target) {
      issues.push({
        severity: 'error',
        message: `Node "${edge.source}" has a self-loop dependency`,
        nodeId: edge.source,
        field: 'depends_on',
        suggestion: 'A node cannot depend on itself',
      });
    }
  }

  // 4. Cycle detection via Kahn's algorithm
  if (hasCycle(nodeIds, edges)) {
    issues.push({
      severity: 'error',
      message: 'Cycle detected in workflow graph',
      suggestion: 'Remove circular dependencies between nodes',
    });
  }

  // 5. Broken $nodeId.output references
  for (const node of nodes) {
    const textsToScan: string[] = [];
    if (node.data.when) textsToScan.push(node.data.when);
    if (node.data.promptText) textsToScan.push(node.data.promptText);
    if (node.data.bashScript) textsToScan.push(node.data.bashScript);
    if (node.data.scriptBody) textsToScan.push(node.data.scriptBody);
    if (node.data.loopConfig?.prompt) textsToScan.push(node.data.loopConfig.prompt);
    if (node.data.loopConfig?.until_bash) textsToScan.push(node.data.loopConfig.until_bash);
    if (node.data.approvalConfig?.message) textsToScan.push(node.data.approvalConfig.message);
    if (node.data.approvalConfig?.on_reject?.prompt) {
      textsToScan.push(node.data.approvalConfig.on_reject.prompt);
    }

    for (const text of textsToScan) {
      const outputRefPattern = /\$(\w+)\.output/g;
      let match: RegExpExecArray | null;
      while ((match = outputRefPattern.exec(text)) !== null) {
        const referencedId = match[1];
        if (!nodeIds.has(referencedId)) {
          issues.push({
            severity: 'warning',
            message: `Node "${node.data.id}" references "$${referencedId}.output" but node "${referencedId}" does not exist`,
            nodeId: node.data.id,
            suggestion: `Check that node ID "${referencedId}" is correct`,
          });
        }
      }
    }
  }

  return issues;
}

export function useBuilderValidation(
  workflowName: string,
  workflowDescription: string,
  nodes: DagFlowNode[],
  edges: Edge[]
): ValidationIssue[] {
  const [debouncedIssues, setDebouncedIssues] = useState<ValidationIssue[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced checks
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      const issues = getDebouncedIssues(nodes, edges);
      setDebouncedIssues(issues);
      timerRef.current = null;
    }, 300);

    return (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [nodes, edges]);

  // Instant checks (every render)
  const instantIssues = getInstantIssues(workflowName, workflowDescription, nodes);

  // Combine and sort by severity (errors first)
  const allIssues = [...instantIssues, ...debouncedIssues];
  allIssues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return allIssues;
}
