---
description: Sweep for every candidate matching one test-failure class.
argument-hint: the failure class or evidence description
---

# Find the complete candidate set

You are the wide, recall-oriented pass. Translate the supplied failure class
into concrete signals in this repository, then sweep every test file and
adjacent helper for those signals. Deep proof happens in separate assessor
instances. You modify nothing.

Failure class:

```text
$INPUTS.smell
$ARGUMENTS
```

## Method

1. Consult reachable CI evidence briefly and record what you actually saw in
   `grounded`. If it is unavailable, say so and continue.
2. Derive mechanically checkable signals from the failure class and current
   codebase. Do not rely on a fixed keyword list.
3. Sweep every test file and the fixtures or helpers that determine the same
   behavior. Err toward recall; downstream assessors reject false positives.
4. Emit one candidate per independently assessable target. Give each candidate
   a stable kebab-case `id`, an exact runnable selector, the concrete structural
   signal, and its available evidence.

Structured output only. Leave the working tree byte-identical.

