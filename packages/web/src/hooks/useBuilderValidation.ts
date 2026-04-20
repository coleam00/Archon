import { useState, useEffect, useRef } from 'react';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';
import type { Edge } from '@xyflow/react';
import { hasCycle } from '@/lib/dag-layout';
import { t } from '@/lib/i18n';

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
      message: t('builder.workflowNameRequired'),
      field: 'name',
    });
  }

  if (!workflowDescription.trim()) {
    issues.push({
      severity: 'error',
      message: t('validation.descriptionRequired'),
      field: 'description',
    });
  }

  if (nodes.length === 0) {
    issues.push({
      severity: 'error',
      message: t('validation.oneNodeRequired'),
    });
  }

  for (const node of nodes) {
    if (node.data.nodeType === 'bash' && !node.data.bashScript?.trim()) {
      issues.push({
        severity: 'error',
        message: `노드 "${node.data.id}": ${t('validation.bashEmpty')}`,
        nodeId: node.data.id,
        field: 'bashScript',
        suggestion: t('validation.enterBash'),
      });
    }
    if (node.data.nodeType === 'prompt' && !node.data.promptText?.trim()) {
      issues.push({
        severity: 'error',
        message: `노드 "${node.data.id}": ${t('validation.promptEmpty')}`,
        nodeId: node.data.id,
        field: 'promptText',
        suggestion: t('validation.enterPrompt'),
      });
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
        message: `중복 노드 ID "${id}" (${count}${t('validation.duplicateNodeIdSuffix')})`,
        nodeId: id,
        field: 'id',
        suggestion: t('validation.uniqueNodeId'),
      });
    }
  }

  // 2. Broken depends_on (missing source or target)
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      issues.push({
        severity: 'error',
        message: `${t('validation.edgeMissingSourcePrefix')} "${edge.source}"`,
        nodeId: edge.target,
        field: 'depends_on',
      });
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        severity: 'error',
        message: `${t('validation.edgeMissingTargetPrefix')} "${edge.target}"`,
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
        message: `노드 "${edge.source}" ${t('validation.selfLoopSuffix')}`,
        nodeId: edge.source,
        field: 'depends_on',
        suggestion: t('validation.noSelfDependency'),
      });
    }
  }

  // 4. Cycle detection via Kahn's algorithm
  if (hasCycle(nodeIds, edges)) {
    issues.push({
      severity: 'error',
      message: t('validation.cycleDetected'),
      suggestion: t('validation.removeCycles'),
    });
  }

  // 5. Broken $nodeId.output references
  for (const node of nodes) {
    const textsToScan: string[] = [];
    if (node.data.when) textsToScan.push(node.data.when);
    if (node.data.promptText) textsToScan.push(node.data.promptText);

    for (const text of textsToScan) {
      const outputRefPattern = /\$(\w+)\.output/g;
      let match: RegExpExecArray | null;
      while ((match = outputRefPattern.exec(text)) !== null) {
        const referencedId = match[1];
        if (!nodeIds.has(referencedId)) {
          issues.push({
            severity: 'warning',
            message: `노드 "${node.data.id}" "$${referencedId}.output"${t('validation.outputReferenceMissingSuffix')}`,
            nodeId: node.data.id,
            suggestion: `${t('validation.checkNodeIdPrefix')} "${referencedId}"`,
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
