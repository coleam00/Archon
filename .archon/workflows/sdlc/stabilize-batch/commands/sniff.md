---
description: Sweep for candidates matching a test-smell class — cheap and wide, no deep verdicts.
argument-hint: the issue class or evidence description
---

# Find Candidates

You are the WIDE pass of a two-stage hunt. Your job is recall: surface every
candidate in this repository that plausibly matches the smell class. Deep
verification happens downstream, per candidate — do NOT spend your budget
proving any single one. Do NOT drop a plausible candidate because you haven't
proven it; flagging suspects cheaply is your whole job. You modify nothing.

Smell to hunt:

```
$INPUTS.smell
$ARGUMENTS
```

(If `$INPUTS.smell` is empty, the trigger message above IS the smell.)

## Method

1. **Ground briefly.** If CI evidence is reachable (`gh run list`, recent logs),
   note what you saw in `grounded` — one line. Unreachable: say so, move on.
   Do not sink time here; grounding is context, not your deliverable.

2. **Translate the smell into concrete, mechanically checkable signals** before
   searching. A smell like "tests flake under load" becomes: which operations
   are wall-clock bound? Which tests share mutable state or external resources?
   What does this repo's own test runner log when it struggles? Derive signals
   FROM the description and THIS codebase — never assume a pattern family.

3. **Sweep every test file** against those signals. Grep wide, skim hits,
   include adjacent tests in the same files — families cluster. Err toward
   inclusion at equal mechanism; a false candidate costs one cheap assessment,
   a missed instance costs a future CI break.

4. **One paragraph of why per candidate.** Name file, a runnable `test_id`
   (selector that runs exactly that test), and the structural signal you saw —
   what the code does, concretely, that matches the signal. CI evidence goes
   in `evidence` when you have it; otherwise say what pattern class this is.

## Output contract

Structured fields only — each candidate becomes one deep-assessment child's
entire world. Nothing outside the declared fields exists afterward.

You are advisory: leave the working tree byte-identical.
