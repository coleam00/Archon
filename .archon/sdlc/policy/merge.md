# Merge queue policy

Archon's additions to the SDLC pack's default merge policy. The queue reads the default
first and this file after it.

## Unclear: the queue asks

- Changes to the SDLC pack itself: its workflows, commands, scripts, their tests or policy documents. Any change under `.archon/` counts, even a test-only change.
- The workflow language: its YAML surface, schemas or validation.
- The plugin protocol, or any contract an outside plugin or provider builds against.
