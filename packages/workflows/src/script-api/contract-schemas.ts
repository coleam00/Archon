import { z } from 'zod';
import { nodeOutcomesListingSchema } from '../schemas/node-outcomes';
import { resourceStartDispositionSchema } from '../schemas/resource-start';
import {
  stateClaimResultSchema,
  stateConflictSchema,
  stateDocumentSummarySchema,
  stateLeaseViewSchema,
  statePatchOpSchema,
  stateRevisionSchema,
} from '../state-document-store';

/** One contract type of `archon:script`: its name there, what it is, and its JSON Schema. */
export interface ScriptContractType {
  readonly name: string;
  readonly doc: string;
  readonly schema: unknown;
}

const types: readonly (readonly [string, string, z.ZodType, 'input' | 'output'])[] = [
  [
    'StateLease',
    "A document's lease; `live` says whether its run still owns it.",
    stateLeaseViewSchema,
    'output',
  ],
  ['StateRevision', 'One revision of a state document.', stateRevisionSchema, 'output'],
  [
    'StateDocumentSummary',
    'A state document as a listing without values reports it.',
    stateDocumentSummarySchema,
    'output',
  ],
  [
    'StatePatchOp',
    'One operation of a state patch; `path` is a JSON Pointer.',
    statePatchOpSchema,
    'input',
  ],
  [
    'StateConflict',
    'Why the store refused a state write without making it.',
    stateConflictSchema,
    'output',
  ],
  [
    'StateClaimResult',
    'What `state claim` took, and why it passed over each earlier candidate.',
    stateClaimResultSchema,
    'output',
  ],
  [
    'NodeOutcomesListing',
    "The engine's listing of what each node of the run has recorded.",
    nodeOutcomesListingSchema,
    'output',
  ],
  [
    'StartDisposition',
    'The admission a fired trigger binding got.',
    resourceStartDispositionSchema,
    'output',
  ],
];

/**
 * The engine-owned shapes a script reads and writes through `archon:script`, as JSON
 * Schema for the generator of its declaration file. The zod schemas stay the owner. A
 * value zod cannot state (any JSON) is left open.
 */
export function scriptContractTypes(): ScriptContractType[] {
  return types.map(([name, doc, schema, io]) => ({
    name,
    doc,
    schema: z.toJSONSchema(schema, { io, unrepresentable: 'any' }),
  }));
}
