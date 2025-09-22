/**
 * Knowledge Feature Module
 *
 * Vertical slice containing all knowledge base functionality:
 * - Knowledge item management (CRUD, search)
 * - Crawling and URL processing
 * - Document upload and processing
 * - Document browsing and viewing
 */

// Components
export * from "./components";
// Hooks
export * from "./hooks";
// Services
export * from "./services";
// Types
export * from "./types";
// Views with error boundary
export { KnowledgeViewWithBoundary } from "./views/KnowledgeViewWithBoundary";
