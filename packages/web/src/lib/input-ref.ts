/** Web copy of the engine input grammar, pinned by scripts/node-ref-parity.test.ts. */
export const INPUTS_SCOPE = 'INPUTS';
export const INPUTS_REF_PREFIX = `$${INPUTS_SCOPE}.`;

// Input names and node ids are separate vocabularies even though their grammars coincide today.
export const INPUT_NAME_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_-]*`;

export const WHOLE_INPUTS_REF_PATTERN = new RegExp(
  String.raw`^\$${INPUTS_SCOPE}\.(${INPUT_NAME_SOURCE})$`
);
