# Language Idioms & Gotchas — Senior Developer Reference

Quick-reference for switching between languages without leaving idiom debt. Each section: idiomatic style, common gotchas, testing convention.

---

## JavaScript / TypeScript

**Idiomatic:**
- `const` by default, `let` only when reassigning, never `var`
- Arrow functions for callbacks; `function` declarations for hoisting or `this` binding
- Async/await over raw Promises; never mix `.then()` and `await` in the same flow
- Object/array destructuring; spread for shallow copy
- Optional chaining (`?.`) and nullish coalescing (`??`) over manual checks
- TypeScript: `unknown` over `any`; narrow with type guards
- Prefer `readonly` arrays/properties unless mutation is required

**Gotchas:**
- `==` vs `===` — always `===` (and `!==`)
- `typeof null === 'object'` — use `value === null`
- Floating point: `0.1 + 0.2 !== 0.3`. Use BigInt or fixed-point for money.
- Array `sort()` is in-place AND lexicographic by default — `[10, 2].sort()` is `[10, 2]`
- `forEach` doesn't await; use `for…of` with async
- `this` rebinding in callbacks — arrow functions inherit, regular functions don't
- Truthy/falsy: `0`, `""`, `NaN`, `null`, `undefined` all falsy. Be explicit.

**Testing:** Vitest or Jest. `describe` / `it` blocks. Snapshot tests sparingly.

---

## Python

**Idiomatic:**
- List/dict/set comprehensions over `map`/`filter`
- `with` blocks for resource management (files, locks, transactions)
- Dataclasses or Pydantic models over plain dicts for typed data
- Type hints everywhere; `mypy` or `pyright` in CI
- f-strings, never `%` or `.format()`
- `pathlib.Path` over `os.path`
- `enumerate(items)` over manual index counters

**Gotchas:**
- Mutable default arguments: `def f(items=[]):` shares one list across calls. Use `None` sentinel.
- Late binding in closures inside loops — capture with default arg
- `is` vs `==` — `is` for identity (None, True, False), `==` for value
- Integer caching: `a is b` may be True for small ints, False for large — never rely on it
- The GIL means threads don't parallelise CPU-bound work; use `multiprocessing` or `asyncio`
- `dict.get(key)` returns None for missing; `dict[key]` raises — pick deliberately

**Testing:** pytest. Fixtures over setup/teardown. Parametrize over copy-paste.

---

## Go

**Idiomatic:**
- Errors are values — `if err != nil { return err }`. Wrap with `fmt.Errorf("doing X: %w", err)`.
- Small interfaces (often 1–2 methods), defined where used not where implemented
- `defer` for cleanup, immediately after acquisition
- Channels for ownership transfer; mutexes for shared state
- `context.Context` as first parameter for anything I/O-bound
- Table-driven tests
- No getters/setters unless they do something

**Gotchas:**
- Loop variable capture in goroutines: `for _, v := range items { go func() { use(v) }() }` — capture explicitly (Go 1.22+ fixed this; older code may bite)
- Slice gotchas: appending may or may not reallocate. Mutating a sub-slice mutates the underlying array.
- nil map writes panic; nil map reads return zero value
- `interface` containing a typed nil is not nil — `var p *T = nil; var i Interface = p; i == nil // false`
- Goroutine leaks if no exit path — always have a way out (context, done channel)

**Testing:** standard `testing` package. `t.Run` for subtests. `testify` for assertions if the team uses it.

---

## Rust

**Idiomatic:**
- `Result<T, E>` for fallible operations; `?` operator for propagation
- `Option<T>` over null/sentinel values
- Borrowing over cloning; `&str` over `String` for parameters
- Iterator chains over manual loops
- `Box<dyn Error>` or a concrete error enum (`thiserror` for libraries, `anyhow` for applications)
- Pattern matching is exhaustive — let the compiler enforce it

**Gotchas:**
- Borrow checker — fight it less by structuring code with clear ownership
- `String` vs `&str` vs `&String` — return `String`, accept `&str`
- `clone()` is sometimes the right answer; don't fight it for trivial cases
- Lifetimes in struct fields propagate; consider whether you actually need a reference
- Async runtimes don't compose — pick one (tokio is default)

**Testing:** built-in `cargo test`. `#[cfg(test)] mod tests` at file bottom.

---

## Java

**Idiomatic:**
- Records for immutable data (Java 14+)
- Streams for collection processing; not for everything
- `Optional<T>` for return values that may be absent (not for fields/parameters)
- `final` on locals when not reassigned; signals intent
- Constructor injection over field/setter injection
- Try-with-resources for `AutoCloseable`

**Gotchas:**
- `==` vs `.equals()` — `==` is reference equality
- Boxed numerics in maps: `Long(1) != Long(1)` with `==`
- `null` in collections — `Map.of()` rejects, `HashMap` accepts
- Checked exceptions in lambdas — they don't propagate; wrap or use a sneaky-throw
- Time: `java.time` (post-Java 8), never `Date`/`Calendar`

**Testing:** JUnit 5. `@Test`, `@ParameterizedTest`. AssertJ for fluent assertions.

---

## C# / .NET

**Idiomatic:**
- LINQ for collection queries
- `async`/`await` everywhere I/O happens; `Task` returns
- Records for value types; `init` setters for immutability
- Nullable reference types enabled (`<Nullable>enable</Nullable>`)
- `using` declarations (C# 8+) for cleaner scope
- Pattern matching (`switch` expressions, `is` patterns)

**Gotchas:**
- `async void` is a footgun — only for event handlers
- `Task.Result` and `.Wait()` deadlock in sync contexts (UI, ASP.NET classic)
- LINQ deferred execution — multiple enumerations re-execute the query
- DateTime vs DateTimeOffset — use the latter when the offset matters
- `string` is reference-type but value-equality semantics

**Testing:** xUnit (preferred) or NUnit. `[Fact]` / `[Theory]`. FluentAssertions popular.

---

## Ruby

**Idiomatic:**
- Blocks (`do…end` for multi-line, `{…}` for single-line)
- `attr_reader/writer/accessor` over hand-rolled getters
- Duck typing — `respond_to?` over class checks
- Symbols for keys and named constants
- `each` / `map` / `select` / `reject` over `for` loops
- Rails: prefer ActiveRecord scopes over class methods returning relations

**Gotchas:**
- Truthy values — only `nil` and `false` are falsy. `0` and `""` are truthy.
- `&&` vs `and` — different precedence. Use `&&` / `||` in expressions, `and` / `or` for control flow only.
- Mutating methods (`!`) vs non-mutating — `sort` returns new, `sort!` mutates
- `puts` vs `print` vs `p` — `p` calls `inspect`, useful for debugging

**Testing:** RSpec. `describe`/`context`/`it`. Stubbing via `allow`/`receive`.

---

## PHP

**Idiomatic:**
- Strict types: `declare(strict_types=1);` at top of every file
- Constructor property promotion (PHP 8+)
- Match expressions over switch
- Readonly properties (PHP 8.1+) for immutability
- Composer + PSR-4 autoloading
- Type-hint everything

**Gotchas:**
- Loose vs strict comparison — `==` does type juggling, `===` doesn't
- Array vs object — arrays are everything (list, dict, ordered map)
- `null` propagation through arithmetic — `null + 1 === 1` (warning in PHP 8+)
- String to number coercion is its own circle of hell

**Testing:** PHPUnit. `#[Test]` attribute (PHPUnit 10+).

---

## Swift

**Idiomatic:**
- Optionals (`?`) and unwrapping (`if let`, `guard let`)
- `struct` over `class` unless reference semantics required
- Protocols + extensions over inheritance
- Trailing closure syntax
- `Result<Success, Failure>` for fallible APIs
- Async/await (Swift 5.5+)

**Gotchas:**
- Force unwrap (`!`) is a runtime crash waiting to happen
- Implicit unwrap (`var x: Int!`) — same problem, hidden
- `==` requires `Equatable`; reference identity is `===`
- Memory — strong reference cycles in closures need `[weak self]`

**Testing:** XCTest. `XCTAssert*` family.

---

## Kotlin

**Idiomatic:**
- `val` over `var`; immutable by default
- Data classes for value types
- Null safety baked in — `?` and `!!`
- Scope functions (`let`, `apply`, `also`, `run`, `with`) used judiciously
- Coroutines over RxJava for new code
- Extension functions for clean API surfaces

**Gotchas:**
- `!!` is a panic in disguise
- `lateinit` for non-null fields initialised after construction — accessing before init throws
- Java interop: platform types (`String!`) bypass null checks
- `companion object` is not the same as Java `static` — methods are on the companion instance

**Testing:** JUnit 5 + Kotest or MockK.

---

## SQL (cross-dialect notes)

**Idiomatic:**
- Explicit column lists in SELECT (never `SELECT *` in production)
- Always parameterise — never concatenate user input
- Index foreign keys, query predicates, and ORDER BY columns
- Use transactions for multi-statement consistency
- CTEs for readability over nested subqueries

**Gotchas:**
- NULL doesn't equal NULL — use `IS NULL` / `IS NOT NULL`
- `COUNT(*)` vs `COUNT(col)` — the second skips nulls
- `JOIN` without `ON` is a Cartesian product
- `LIMIT` without `ORDER BY` is non-deterministic
- Implicit type coercion varies wildly between Postgres / MySQL / SQLite
