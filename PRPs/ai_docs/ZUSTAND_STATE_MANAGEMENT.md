Zustand v4 AI Coding Assistant Standards

Purpose

These guidelines define how an AI coding assistant should generate, refactor, and reason about Zustand (v4) state management code. They serve as enforceable standards to ensure clarity, consistency, maintainability, and performance across all code suggestions.

⸻

1. General Rules
	•	Use TypeScript for all Zustand stores.
	•	All stores must be defined with the create() function from Zustand v4.
	•	State must be immutable; never mutate arrays or objects directly.
	•	Use functional updates with set((state) => ...) whenever referencing existing state.
	•	Never use useStore.getState() inside React render logic.

⸻

2. Store Creation Rules

Do:

import { create } from 'zustand';

type CounterStore = {
  count: number;
  increment: () => void;
  reset: () => void;
};

export const useCounterStore = create<CounterStore>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  reset: () => set({ count: 0 })
}));

Don’t:
	•	Define stores inline within components.
	•	Create multiple stores for related state when a single one suffices.
	•	Nest stores inside hooks or conditional logic.

Naming conventions:
	•	Hook: use<Entity>Store (e.g., useUserStore, useThemeStore).
	•	File: same as hook (e.g., useUserStore.ts).

⸻

3. Store Organization Rules
	•	Each feature (e.g., agent-work-orders, knowledge, settings, etc..) should have its own store file.
	•	Combine complex stores using slices, not nested state.
	•	Use middleware (persist, devtools, immer) only when necessary.

Example structure:

src/features/knowledge/state/
  ├── knowledgeStore.ts
  └── slices/ #If necessary
      ├── nameSlice.ts #a name that represents the slice if needed


⸻

4. Selector and Subscription Rules

Core Principle: Components should subscribe only to the exact slice of state they need.

Do:

const count = useCounterStore((s) => s.count);
const increment = useCounterStore((s) => s.increment);

Don’t:

const { count, increment } = useCounterStore(); // ❌ Causes unnecessary re-renders

Additional rules:
	•	Use shallow comparison (shallow) if selecting multiple fields.
	•	Avoid subscribing to derived values that can be computed locally.

⸻

5. Middleware and Side Effects

Allowed middleware: persist, devtools, immer, subscribeWithSelector.

Rules:
	•	Never persist volatile or sensitive data (e.g., tokens, temp state).
	•	Configure partialize to persist only essential state.
	•	Guard devtools with environment checks.

Example:

import { create } from 'zustand';
import { persist, devtools } from 'zustand/middleware';

export const useSettingsStore = create(
  devtools(
    persist(
      (set) => ({
        theme: 'light',
        toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' }))
      }),
      {
        name: 'settings-store',
        partialize: (state) => ({ theme: state.theme })
      }
    )
  )
);


⸻

6. Async Logic Rules
	•	Async actions should be defined inside the store.
	•	Avoid direct useEffect calls that depend on store state.

Do:

fetchData: async () => {
  const data = await api.getData();
  set({ data });
}

Don’t:

useEffect(() => {
  useStore.getState().fetchData(); // ❌ Side effect in React hook
}, []);


⸻

7. Anti-Patterns

❌ Anti-Pattern	🚫 Reason
Subscribing to full store	Causes unnecessary re-renders
Inline store creation in component	Breaks referential integrity
Mutating state directly	Zustand expects immutability
Business logic inside components	Should live in store actions
Using store for local-only UI state	Clutters global state
Multiple independent stores for one domain	Increases complexity


⸻

8. Testing Rules
	•	Each store must be testable as a pure function.
	•	Tests should verify: initial state, action side effects, and immutability.

Example Jest test:

import { useCounterStore } from '../state/useCounterStore';

test('increment increases count', () => {
  const { increment, count } = useCounterStore.getState();
  increment();
  expect(useCounterStore.getState().count).toBe(count + 1);
});


⸻

9. Documentation Rules
	•	Every store file must include:
	•	Top-level JSDoc summarizing store purpose.
	•	Type definitions for state and actions.
	•	Examples for consumption patterns.
	•	Maintain a STATE_GUIDELINES.md index in the repo root linking all store docs.

⸻

10. Enforcement Summary (AI Assistant Logic)

When generating Zustand code:
	•	ALWAYS define stores with create() at module scope.
	•	NEVER create stores inside React components.
	•	ALWAYS use selectors in components.
	•	AVOID getState() in render logic.
	•	PREFER shallow comparison for multiple subscriptions.
	•	LIMIT middleware to proven cases (persist, devtools, immer).
	•	TEST every action in isolation.
	•	DOCUMENT store purpose, shape, and actions.

⸻
# Zustand v3 → v4 Summary (for AI Coding Assistants)

## Overview
Zustand v4 introduced a few key syntax and type changes focused on improving TypeScript inference, middleware chaining, and internal consistency.  
All existing concepts (store creation, selectors, middleware, subscriptions) remain — only the *patterns* and *type structure* changed.

---

## Core Concept Changes
- **Curried Store Creation:**  
  `create()` now expects a *curried call* form when using generics or middleware.  
  The previous single-call pattern is deprecated.

- **TypeScript Inference Improvements:**  
  v4’s curried syntax provides stronger type inference for complex stores and middleware combinations.

- **Stricter Generic Typing:**  
  Functions like `set`, `get`, and the store API have tighter TypeScript types.  
  Any implicit `any` usage or loosely typed middleware will now error until corrected.

---

## Middleware Updates
- Middleware is still supported but must be imported from subpaths (e.g., `zustand/middleware/immer`).  
- The structure of most built-in middlewares (persist, devtools, immer, subscribeWithSelector) remains identical.  
- Chaining multiple middlewares now depends on the curried `create` syntax for correct type inference.

---

## Persistence and Migration
- `persist` behavior is unchanged functionally, but TypeScript typing for the `migrate` function now defines the input state as `unknown`.  
  You must assert or narrow this type when using TypeScript.  
- The `name`, `version`, and other options are unchanged.

---

## Type Adjustments
- The `set` function now includes a `replace` parameter for full state replacement.  
- `get` and `api` generics are explicitly typed and must align with the store definition.  
- Custom middleware and typed stores may need to specify generic parameters to avoid inference gaps.

---

## Behavior and API Consistency
- Core APIs like `getState()`, `setState()`, and `subscribe()` are still valid.  
- Hook usage (`useStore(state => state.value)`) is identical.  
- Differences are primarily at compile time (typing), not runtime.

---

## Migration/Usage Implications
For AI agents generating Zustand code:
- Always use the **curried `create<Type>()(…)`** pattern when defining stores.  
- Always import middleware from `zustand/middleware/...`.  
- Expect `set`, `get`, and `api` to have stricter typings.  
- Assume `migrate` in persistence returns `unknown` and must be asserted.  
- Avoid any v3-style `create<Type>(fn)` calls.  
- Middleware chaining depends on the curried syntax — never use nested functions without it.

---

## Reference Behavior
- Functional concepts are unchanged: stores, actions, and reactivity all behave the same.  
- Only the declaration pattern and TypeScript inference system differ.

---

## Summary
| Area | Zustand v3 | Zustand v4 |
|------|-------------|------------|
| Store creation | Single function call | Curried two-step syntax |
| TypeScript inference | Looser | Stronger, middleware-aware |
| Middleware imports | Flat path | Sub-path imports |
| Migrate typing | `any` | `unknown` |
| API methods | Same | Same, stricter typing |
| Runtime behavior | Same | Same |

---

## Key Principle for Code Generation
> “If defining a store, always use the curried `create()` syntax, import middleware from subpaths, and respect stricter generics. All functional behavior remains identical to v3.”

---

**Recommended Source:** [Zustand v4 Migration Guide – Official Docs](https://zustand.docs.pmnd.rs/migrations/migrating-to-v4)
