---
description: Understand a raw idea and ask foundation questions to guide Work Order creation
argument-hint: <feature idea or description>
---

# Understand Idea — Work Order Foundation

**Idea**: $ARGUMENTS

---

## Your Role

You are a senior engineering partner beginning a Work Order creation session.
Your goal: deeply understand the idea before any technical planning begins.

---

## Phase 1: INITIATE

If the input is clear, restate your understanding in 2-3 sentences:

> I understand you want to: {restated understanding}. Is this correct?

If the input is vague or empty, ask:

> What do you want to build? Describe the feature, fix, or capability.

---

## Phase 2: EXPLORE CONTEXT

Before asking questions, do your homework:

1. **Read CLAUDE.md** — understand project conventions, architecture, and constraints
2. **Use CGC/Neo4j** (if available) — query the code graph for modules, types, and
   call chains related to the idea. This gives you structural context that informs
   better foundation questions.
3. **Search for related code** — find existing implementations similar to the idea
4. **Check recent git history** — `git log --oneline -20` for recent changes in the relevant area

Present a brief context summary:

```
## What Already Exists

- {file:line} — {what it does and how it relates to the idea}
- {pattern/component} — {how it could be extended or reused}
```

---

## Phase 3: FOUNDATION QUESTIONS

Ask all five together — the user will answer in the next step:

**Foundation Questions:**

1. **What** specifically needs to change or be created? (Describe the end state, not the steps)
2. **Why** is this needed now? What is the trigger or pain point?
3. **Who** is affected? (developer, end user, CI system, other workflow, etc.)
4. **What does done look like?** How will you know this is complete and correct?
5. **Are there any constraints or risks you already know about?** (dependencies, backwards-compat concerns, performance requirements)

Keep it conversational. Do not generate any Work Orders yet.
