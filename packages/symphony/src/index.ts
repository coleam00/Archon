// @archon/symphony — autonomous Linear+GitHub tracker dispatch on top of Archon workflows.
// Phase 1 scaffolding only. See docs/superpowers/plans/2026-04-30-archon-symphony-consolidation.md
// in the symphoney-codex repo for the consolidation roadmap.
//
// Phase 2 will add the orchestrator (ported from symphoney-codex/src/orchestrator/).
// Phase 3 will add workflow-bridge dispatcher.
//
// For now this package owns only the DB schema for symphony_dispatches and a typed
// CRUD module under ./db/dispatches.

export type { DispatchRow, DispatchStatus, DispatchTracker } from './db/dispatches';
