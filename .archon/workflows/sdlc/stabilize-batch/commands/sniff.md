---
description: Ground against CI evidence, then sweep the codebase for every instance of the smell class.
argument-hint: the issue class or evidence description
---

# Sniff: Find Every Instance of This Smell

You are hunting a CLASS of test problems, not one failure. Your input is a
smell description (and possibly evidence references). Your output is the
complete list of instances in this repository — confirmed and suspected —
as structured data. You modify nothing.

Smell to hunt:

```
$INPUTS.smell
$ARGUMENTS
```

(If `$INPUTS.smell` is empty, the trigger message above IS the smell.)

## Method

1. **Ground first.** If the smell references CI behavior, consult what is
   reachable (`gh run list`, recent run logs via `gh api`) and record one line
   in `grounded` about what you actually saw. If nothing is reachable from
   here, say so — do not invent CI evidence.

2. **Define the pattern mechanically.** Translate the smell into concrete,
   greppable signals before searching. For "tests timing out at Bun's 5000ms
   default in windows CI" that means: tests that spawn subprocesses per-case or
   in loops; process-tree teardown helpers; repeated `bun test` invocations;
   anything whose runtime is dominated by process creation on slow runners.

3. **Sweep wide, then read.** Grep for every signal across all test files.
   Read each hit's context — a grep hit alone is not a finding. Also read
   adjacent tests in the same files: families cluster.

4. **Record near-misses.** A test with the same structural risk that has not
   flaked YET is a finding at `confidence: "suspected"`. The point of a batch
   is to fix the family once, not wait for each member to bite separately.
   Do not pad the list — only include suspects you would defend.

5. **Evidence bar.** Every finding carries `file`, a runnable `test_id`
   (selector that runs exactly that test), `why_suspect` naming the mechanism
   ("spawns ~40 subprocesses per case; spawn cost on windows runners exceeds
   the 5000ms bound"), and `evidence` (CI link, timing number, or code line).
   If your reasoning contains "might" or "could", investigate until concrete —
   or drop it to silence.

## Output contract

Your only product is the structured fields. Findings feed a work-order splitter
that shares none of your context — every field must stand alone. Nothing you
write outside the declared fields exists afterward.

You are advisory: leave the working tree byte-identical.
