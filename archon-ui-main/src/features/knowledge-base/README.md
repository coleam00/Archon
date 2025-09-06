# Knowledge Base Feature

This directory contains the Knowledge Base feature implementation following the vertical slice architecture pattern.

## Structure

```
knowledge-base/
├── components/      # UI components
├── hooks/          # TanStack Query hooks and custom hooks
├── services/       # API service layer
├── types/          # TypeScript type definitions
├── views/          # Page-level components
└── index.ts        # Public API exports
```

## Migration Status

- [ ] Move KnowledgeBasePage from /pages
- [ ] Migrate components from /components/knowledge-base
- [ ] Implement TanStack Query hooks
- [ ] Add tests colocated with components
- [ ] Update imports throughout the app