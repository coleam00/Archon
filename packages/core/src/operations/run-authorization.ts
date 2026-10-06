export type RunActor =
  | { kind: 'operator' }
  | { kind: 'user'; userId: string }
  | { kind: 'unidentified' };
