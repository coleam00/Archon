/** The pack's marker sentence, as the installed pack's `deliver` result script writes it. */
export const MARKER = 'The stage offered these, in its own words; say which in your answer:';

/** An ask's context and recommendation, from a dry run of that script (2026-11-20, item #111). */
export const DRY_RUN_CONTEXT = `Review says the item asks for it; product says it was never mentioned. (Left by: verdict.)

${MARKER}
- build-it: Build the empty state now. (cost: One more round.)
- leave-it: Leave it for a follow-up item. (cost: The board shows a blank column until then.)`;
export const DRY_RUN_WHY = 'The stage recommends "build-it". The item text names the empty state.';

/** The four routes every ask of that script offers. */
export const DRY_RUN_ROUTES = [
  {
    id: 'send-back',
    does: 'The same builder continues on the change with what you say in your answer.',
    cost: 'One more delivery run.',
  },
  {
    id: 'replan',
    does: 'The item goes back to planning with what you say in your answer.',
    cost: 'The work so far may be discarded.',
  },
  {
    id: 'take-as-is',
    does: 'The change stands as it is; nothing more is built. An operator lands it or closes it.',
    cost: 'What the checks returned stays unfixed.',
  },
  { id: 'hold', does: 'Nothing proceeds until an operator says more.', cost: 'The item waits.' },
];
