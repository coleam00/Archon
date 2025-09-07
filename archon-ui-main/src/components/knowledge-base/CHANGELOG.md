# Knowledge Base UI — Changelog

## [Unreleased] - 2025-09-06
- Added explicit upload controls: three buttons (Single File, Multiple Files, Folder) for clear intent and reliable pickers.
- Single-file picker no longer triggers folder selection; grouping is not toggled in this mode.
- Folder picker (webkitdirectory) auto-enables “Group as single source” and suggests the top-level folder name as Source Title.
- Accept types expanded: .pdf, .md, .doc, .docx, .txt, .html, .py, .js, .ts, .tsx.
- Selection summary shows first item + count/size to confirm user intent.

Files: `AddKnowledgeModal.tsx`
