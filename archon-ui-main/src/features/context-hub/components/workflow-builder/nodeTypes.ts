/**
 * Node Type Registry
 *
 * Exports all custom node types for React Flow.
 */

import { TypeNode } from "./TypeNode";
import { TemplateSelectorNode } from "./TemplateSelectorNode";
import { TemplateNode } from "./TemplateNode";
import { SubStepNode } from "./SubStepNode";
import { GitNode } from "./GitNode";
import { PlusIconNode } from "./PlusIconNode";
import { DiamondAddNode } from "./DiamondAddNode";

export const nodeTypes = {
  typeNode: TypeNode,
  templateSelectorNode: TemplateSelectorNode,
  templateNode: TemplateNode,
  subStepNode: SubStepNode,
  gitNode: GitNode,
  plusIconNode: PlusIconNode,
  diamondAddNode: DiamondAddNode,
};

