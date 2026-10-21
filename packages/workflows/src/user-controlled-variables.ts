export interface UserControlledVariableContext {
  userMessage: string;
  loopUserInput?: string;
  rejectionReason?: string;
  loopPrevOutput?: string;
  issueContext?: string;
}

interface UserControlledVariableGroup {
  readonly names: readonly string[];
  readonly source: keyof UserControlledVariableContext;
  readonly kind: 'text' | 'context';
}

export const USER_CONTROLLED_VARIABLES = [
  { names: ['USER_MESSAGE', 'ARGUMENTS'], source: 'userMessage', kind: 'text' },
  { names: ['LOOP_USER_INPUT'], source: 'loopUserInput', kind: 'text' },
  { names: ['REJECTION_REASON'], source: 'rejectionReason', kind: 'text' },
  { names: ['LOOP_PREV_OUTPUT'], source: 'loopPrevOutput', kind: 'text' },
  {
    names: ['CONTEXT', 'EXTERNAL_CONTEXT', 'ISSUE_CONTEXT'],
    source: 'issueContext',
    kind: 'context',
  },
] as const satisfies readonly UserControlledVariableGroup[];
