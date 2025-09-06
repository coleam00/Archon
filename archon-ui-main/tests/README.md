# Test Structure

## Test Organization

We follow a hybrid testing strategy:

### Unit Tests (Colocated)
Unit tests live next to the code they test in the `src/features` directory:
```
src/features/projects/
├── components/
│   ├── ProjectCard.tsx
│   └── ProjectCard.test.tsx
```

### Integration Tests
Tests that cross multiple features/systems:
```
tests/integration/
└── api.integration.test.ts
```

### E2E Tests
Full user flow tests:
```
tests/e2e/
└── user-flows.e2e.test.ts
```

## Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage

# Run specific test file
npx vitest run src/features/ui/hooks/useSmartPolling.test.ts
```

## Test Naming Conventions

- **Unit tests**: `ComponentName.test.tsx` or `hookName.test.ts`
- **Integration tests**: `feature.integration.test.ts`
- **E2E tests**: `flow-name.e2e.test.ts`

## Test Setup

Global test setup is in `tests/setup.ts` which:
- Sets environment variables
- Mocks fetch and localStorage
- Mocks DOM APIs
- Mocks external libraries (lucide-react)