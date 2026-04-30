# Design Patterns — Senior Developer Reference

Patterns are tools, not goals. Reach for one only when the problem genuinely fits. Half the value of knowing patterns is recognising when *not* to use them.

## When to Reach for a Pattern

- Same shape of problem appearing 3+ times in the codebase
- A boundary forming between two concerns that need to vary independently
- Existing code has visible pain (long parameter lists, switch-on-type, shotgun edits)

## When NOT to Reach for a Pattern

- Single use case — duplication is fine
- The pattern adds more indirection than the problem deserves
- The team won't recognise it
- "It might be useful later" — wait for later

---

## Creational

### Factory / Factory Method
**Use when:** caller needs an instance but shouldn't know the concrete class. Common for plugin systems, parsers, adapters.
**Trap:** Don't introduce a factory for a single type — just call the constructor.

### Builder
**Use when:** an object has many optional fields, or construction requires multiple steps with validation between them.
**Trap:** If your language has named arguments / object literals, you usually don't need this.

### Singleton
**Use when:** there is genuinely one of something (a connection pool, a logger). Even then, prefer dependency injection so tests can swap it.
**Trap:** Singletons are global state. They make testing painful. Resist.

---

## Structural

### Adapter
**Use when:** wrapping a third-party API to fit your domain interface. Common at system edges.
**Trap:** Don't adapt your own code to itself. That's just wrapping.

### Facade
**Use when:** a subsystem has 8 classes and callers only need 3 entry points. Simplifies the surface.
**Trap:** A facade that just re-exports everything is noise.

### Decorator
**Use when:** layering orthogonal concerns (logging, caching, retry, auth) over a core operation.
**Trap:** In languages with first-class functions, higher-order functions usually do this more cleanly than class decorators.

### Proxy
**Use when:** controlling access (lazy load, permission check, remote call). Same interface as the real object.

### Composite
**Use when:** you have tree-shaped data (DOM, file system, expression trees) and want to treat leaves and branches uniformly.

---

## Behavioural

### Strategy
**Use when:** an algorithm varies and the variation is selected at runtime. Replaces switch-on-type.
**Trap:** Don't introduce strategy for a single implementation. Wait for the second.

### Observer / Pub-Sub
**Use when:** loose coupling between event source and consumers. Event buses, reactive streams.
**Trap:** Implicit data flow makes debugging hard. Explicit calls beat events when there's only one consumer.

### Command
**Use when:** you need to queue, log, undo, or retry an operation. Each operation becomes an object with `execute()`/`undo()`.

### Iterator
**Use when:** traversing a structure without exposing its internals. Most modern languages bake this in (`for…of`, generators, iterators).

### Template Method
**Use when:** algorithm skeleton is fixed but specific steps vary. Often better expressed as a pure function with callbacks.

### State
**Use when:** an object has clearly distinct modes with different behaviour and complex transitions. Beats nested conditionals on a status field.

### Chain of Responsibility
**Use when:** middleware pipelines (Express, Fastify, Rack). Each handler decides whether to handle or pass on.

### Visitor
**Use when:** double-dispatch over a closed set of types where you need to add operations without modifying the types. Rare; usually only worth it in compilers/AST work.

---

## Architectural Patterns

### Repository
**Use when:** you want a domain-shaped API over storage so the domain layer doesn't import SQL/ORM directly.
**Trap:** Don't add a repository over a repository. ORMs are already repositories.

### Service Layer
**Use when:** orchestrating multiple repositories or domain operations behind a use-case-shaped API.
**Trap:** Anaemic services that just forward calls add zero value. Delete them.

### CQRS
**Use when:** read and write paths have genuinely different shapes (different scaling, different consistency needs).
**Trap:** For most CRUD apps, CQRS is overkill. Plain repositories are fine.

### Event Sourcing
**Use when:** you need an audit trail, time-travel, or to derive multiple read models from the same source of truth.
**Trap:** Operationally expensive. Don't adopt it for "future flexibility".

### Hexagonal / Ports & Adapters
**Use when:** the domain core is complex and stable, while the I/O surface (HTTP, queue, DB, CLI) is varied or likely to change.

### Saga
**Use when:** coordinating a multi-step process across services where you need compensation on failure (no distributed transactions).

---

## SOLID — Pragmatic Reading

- **S — Single Responsibility:** one *reason to change*. A 500-line class with one method violates this; a 5-line class with five methods may not.
- **O — Open/Closed:** prefer composition over modifying tested code. But don't pre-build extension points without a real second case.
- **L — Liskov Substitution:** subclasses must honour the parent's contract. If you're overriding to throw `NotImplementedError`, the inheritance is wrong.
- **I — Interface Segregation:** clients shouldn't depend on methods they don't use. Splitting an interface is cheap; merging is hard.
- **D — Dependency Inversion:** depend on abstractions at module boundaries; concrete classes are fine within a module.

## DRY, YAGNI, KISS — In That Priority Order

- **YAGNI (highest):** don't build for hypothetical futures.
- **KISS:** simplest thing that works. A senior dev's superpower is recognising "simple enough."
- **DRY (lowest of the three):** duplication is cheaper than the wrong abstraction. Tolerate up to ~3 occurrences before extracting.

## Concurrency Patterns (Brief)

- **Worker pool** — fixed N workers consuming a queue. Bound concurrency, prevent thundering herds.
- **Pipeline / fan-out-fan-in** — stages connected by channels/streams.
- **Mutex / RWLock** — protect shared state. Prefer message-passing where the language supports it.
- **Idempotency keys** — for at-least-once delivery systems. Make the operation safe to repeat.
- **Backoff with jitter** — for retries against external services. Constant backoff causes synchronised retry storms.
