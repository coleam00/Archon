---
title: Host Skill Mirroring
description: How Archon's host skill roots work for Claude and Codex, and how this fork keeps them in sync.
status: current
---

# Host Skill Mirroring

Archon currently uses two host-skill roots:

- `.claude/skills/archon/`
- `.agents/skills/archon/`

They exist because the outer host tools look in different places:

- Claude Code discovers `.claude/skills/...`
- Codex discovers `.agents/skills/...`

## Policy In This Fork

These are not separate product variants.

They are mirrored copies of the same Archon host skill and must remain
byte-identical.

Canonical authored source:

- `.agents/skills/archon/`

Required mirror:

- `.claude/skills/archon/`

## Update Rule

When editing the Archon host skill:

1. Edit `.agents/skills/archon/`
2. Mirror the same content into `.claude/skills/archon/`
3. Run the drift test

```bash
bun test packages/cli/src/bundled-skill.test.ts
```

That test enforces both:

- `.claude/skills/archon/` exactly matches `.agents/skills/archon/`
- bundled CLI skill assets include every file from the canonical tree

## Install Behavior

`archon setup` installs the mirrored skill into both roots in target repos:

- `.agents/skills/archon/`
- `.claude/skills/archon/`

This prevents Codex and Claude from seeing different Archon instructions in the
same target repository.

## Why Not One Directory?

Because the host runtimes do not currently share a single discovery root.

If Archon later gains one shared host-skill location, this mirror policy can be
removed. Until then, two roots are required, but two independently maintained
skill variants are not.
