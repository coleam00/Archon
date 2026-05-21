# Brand foundation helpers

One-shot scripts for inspecting and patching `public/brand/foundation.html` (the Penpot-exported standalone brand sheet).

| Script | Purpose |
| --- | --- |
| `_find-console.ts` | Decode every JS/JSX asset in the bundle and grep for any case-insensitive `console` references. Used to locate cross-links to the sibling "Archon Console" doc. |
| `_dump.ts <html> <uuid> <out>` | Decode one manifest entry by UUID to a file so you can edit/inspect the source. |
| `_patch.ts <html>` | Re-applies our customisations (currently: removes the top-right `Console →` pill from the bundled JSX). Idempotent — fails loudly if the source no longer matches. |

## When to re-run

If `foundation.html` is re-exported from Penpot, the bundled JSX UUID changes and our patches will need to be reapplied:

```bash
bun packages/docs-web/scripts/brand/_find-console.ts packages/docs-web/public/brand/foundation.html
# Identify the new UUID for the main JSX (look for `<ArchonLockup subtitle="Brand"`)
# Update TARGET_UUID in _patch.ts if needed, then:
bun packages/docs-web/scripts/brand/_patch.ts packages/docs-web/public/brand/foundation.html
```
