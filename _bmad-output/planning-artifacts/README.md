# Archon BMad Planning Handoff

This folder is the local planning input package for isolated Archon implementation.
The implementation environment may not be able to read the parent workspace.
Parent planning must materialize Archon-owned implementation inputs here before Archon BMad implementation starts.

Expected files:

```text
prd.md
architecture.md
epics.md
```

Do not place implementation artifacts here.
Archon implementation artifacts are generated locally under:

```text
Archon/_bmad-output/implementation-artifacts/
```

Run implementation workflows from inside `Archon/`.
Do not rely on parent workspace paths during implementation.
