# Archon BMad Planning Handoff

This folder is the local planning input package for isolated Archon implementation.
The implementation environment may not be able to read the parent workspace.
Parent planning must materialize Archon-owned implementation inputs here before Archon BMad implementation starts.

This folder can hold more than one parent-workspace feature's handoff at a time. Each feature gets its own package so filenames never collide:

- **BMAD TEA V2 Workflow Orchestration** — flat files at the top level of this folder:

  ```text
  prd.md
  architecture.md
  epics.md
  ```

- **Hermes Agent Workflow Commander** — under its own subfolder:

  ```text
  hermes-workflow-commander/prd.md
  hermes-workflow-commander/architecture.md
  hermes-workflow-commander/epics.md
  ```

When materializing a new feature's handoff here, check whether the flat filenames are already taken by a different feature before writing — if so, use a `<feature-slug>/` subfolder instead of overwriting.

Do not place implementation artifacts here.
Archon implementation artifacts are generated locally under:

```text
Archon/_bmad-output/implementation-artifacts/
```

Run implementation workflows from inside `Archon/`.
Do not rely on parent workspace paths during implementation.
