# Test Coverage Findings: PR #1

**Reviewer**: test-coverage-agent
**Date**: 2026-04-11T16:04:30Z
**Source Files**: 3
**Test Files**: 2

---

## Summary

Coverage is materially incomplete for the new landing page. The single `App` test validates one hero heading, one CTA target, and one workflow heading, but it leaves most of the page's user-visible content, navigation anchors, and accessibility labels unprotected.

The existing test is behavior-oriented and passes under the intended Vitest runner, which is a good base. It is still too narrow to catch meaningful regressions in the repeated card content and internal navigation that make up the bulk of this PR.

**Verdict**: REQUEST_CHANGES

---

## Coverage Map

| Source File      | Test File          | New Code Tested | Modified Code Tested |
| ---------------- | ------------------ | --------------- | -------------------- |
| `src/App.tsx`    | `src/App.test.tsx` | PARTIAL         | N/A                  |
| `src/main.tsx`   | (missing)          | NONE            | N/A                  |
| `src/styles.css` | (missing)          | NONE            | N/A                  |

---

## Findings

### Finding 1: Repeated Landing-Page Content Is Largely Untested

**Severity**: HIGH
**Category**: missing-test
**Location**: `src/App.tsx:62` / `src/App.test.tsx`
**Criticality Score**: 8

**Issue**:
The test does not verify the three proof points, the three capability cards, the three workflow steps, or the final CTA block. Most of the business content in this PR is rendered from arrays, but none of that repeated output is asserted.

**Untested Code**:

```typescript
// This code at src/App.tsx:62 is not tested
<aside className="hero-panel" aria-label="핵심 수치">
  <p className="panel-label">왜 Archon인가</p>
  <ul className="metric-list">
    {proofPoints.map((item) => (
      <li key={item.label}>
        <strong>{item.value}</strong>
        <span>{item.label}</span>
      </li>
    ))}
  </ul>
</aside>

<section className="content-grid" aria-label="주요 기능">
  {capabilities.map((item) => (
    <article className="card" key={item.title}>
      <p className="card-kicker">Core capability</p>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
    </article>
  ))}
</section>

<div className="workflow-grid">
  {workflow.map((item) => (
    <article className="step-card" key={item.step}>
      <span className="step-index">{item.step}</span>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
    </article>
  ))}
</div>
```

**Why This Matters**:
If one of the mapped arrays is shortened, reordered incorrectly, or loses copy during refactoring, the current test still passes.
If a section label or card title disappears, users would lose key page content without any regression signal.
A future change to the data arrays could silently break the page's main value proposition while the suite remains green.

---

#### Test Suggestions

| Option | Approach                                                                                                             | Catches                                            | Effort |
| ------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------ |
| A      | Add assertions for the rendered counts and representative text of proof points, capability cards, and workflow steps | Missing cards, removed copy, broken mapping output | LOW    |
| B      | Split into section-focused tests that verify each landmark and its visible content                                   | Same as A, plus clearer failure isolation          | MED    |

**Recommended**: Option B

**Reasoning**:
It matches the current Testing Library pattern of rendering the whole page and querying by accessible text.
It tests behavior rather than implementation because it asserts what users can read and navigate.
It gives better failure messages than one long omnibus test while keeping maintenance cost low.

**Recommended Test**:

```typescript
describe("App", () => {
  it("renders the proof points and capability cards", () => {
    render(<App />);

    expect(screen.getByLabelText("핵심 수치")).toBeInTheDocument();
    expect(screen.getByText("1 페이지")).toBeInTheDocument();
    expect(screen.getByText("320px+")).toBeInTheDocument();
    expect(screen.getByText("정적 구성")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 3, name: "코드 작성과 리뷰를 한 흐름으로" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "여러 작업을 동시에 조율" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "검증 가능한 결과물 중심" })).toBeInTheDocument();
  });

  it("renders all workflow steps and the final CTA", () => {
    render(<App />);

    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("03")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /복잡한 개발 흐름을 정리할 준비가 된 팀이라면/ })).toBeInTheDocument();
  });
});
```

**Test Pattern Reference**:

```typescript
// SOURCE: src/App.test.tsx:4-24
describe("App", () => {
  it("renders the Korean hero headline and CTA sections", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /Archon은 코딩 작업과 프로젝트 흐름을 함께 지휘합니다\./,
      }),
    ).toBeInTheDocument();
  });
});
```

---

### Finding 2: Navigation And Accessibility Contracts Are Only Partially Verified

**Severity**: MEDIUM
**Category**: missing-edge-case
**Location**: `src/App.tsx:56` / `src/App.test.tsx`
**Criticality Score**: 6

**Issue**:
Only one internal anchor is verified. The secondary hero CTA, both final CTA links, and the named regions exposed through `aria-label` are untested, even though they are the page's main interaction and accessibility contracts.

**Untested Code**:

```typescript
// This code at src/App.tsx:56 is not tested
<a className="secondary-cta" href="#workflow">
  작업 흐름 보기
</a>

<section className="content-grid" aria-label="주요 기능">
  {capabilities.map((item) => (
    <article className="card" key={item.title}>
      <p className="card-kicker">Core capability</p>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
    </article>
  ))}
</section>

<a className="primary-cta" href="#top">
  처음부터 다시 보기
</a>
<a className="secondary-cta" href="#capabilities">
  기능 다시 확인
</a>
```

**Why This Matters**:
If anchor targets change or are deleted, users would click through to nowhere and the current test would not detect it.
If labels like `핵심 수치` or `주요 기능` are removed, screen-reader navigation regresses without coverage.
These are stable user-facing contracts, so they are cheap and valuable to protect.

---

#### Test Suggestions

| Option | Approach                                                                   | Catches                                          | Effort |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------ | ------ |
| A      | Assert all CTA links have the expected `href` values                       | Broken in-page navigation                        | LOW    |
| B      | Assert both CTA targets and labeled regions are discoverable by role/label | Broken navigation plus accessibility regressions | LOW    |

**Recommended**: Option B

**Reasoning**:
The codebase already uses role-based queries, so this extends the existing style instead of introducing brittle selectors.
It covers visible behavior and accessibility semantics together.
The assertions are inexpensive and resilient to refactoring.

**Recommended Test**:

```typescript
it("exposes the expected in-page navigation and labeled sections", () => {
  render(<App />);

  expect(screen.getByRole("link", { name: "핵심 기능 보기" })).toHaveAttribute("href", "#capabilities");
  expect(screen.getByRole("link", { name: "작업 흐름 보기" })).toHaveAttribute("href", "#workflow");
  expect(screen.getByRole("link", { name: "처음부터 다시 보기" })).toHaveAttribute("href", "#top");
  expect(screen.getByRole("link", { name: "기능 다시 확인" })).toHaveAttribute("href", "#capabilities");

  expect(screen.getByLabelText("핵심 수치")).toBeInTheDocument();
  expect(screen.getByLabelText("주요 기능")).toBeInTheDocument();
});
```

**Test Pattern Reference**:

```typescript
// SOURCE: src/App.test.tsx:15-23
expect(screen.getByRole('link', { name: '핵심 기능 보기' })).toHaveAttribute(
  'href',
  '#capabilities'
);

expect(
  screen.getByRole('heading', {
    level: 2,
    name: /계획부터 검증까지, 팀이 따라가기 쉬운 실행 루프/,
  })
).toBeInTheDocument();
```

---

## Test Quality Audit

| Test                                                | Tests Behavior | Resilient | Meaningful Assertions | Verdict    |
| --------------------------------------------------- | -------------- | --------- | --------------------- | ---------- |
| `renders the Korean hero headline and CTA sections` | YES            | YES       | PARTIAL               | NEEDS_WORK |

---

## Statistics

| Severity | Count | Criticality 8-10 | Criticality 5-7 | Criticality 1-4 |
| -------- | ----- | ---------------- | --------------- | --------------- |
| CRITICAL | 0     | 0                | -               | -               |
| HIGH     | 1     | 1                | 0               | -               |
| MEDIUM   | 1     | -                | 1               | 0               |
| LOW      | 0     | -                | -               | 0               |

---

## Risk Assessment

| Untested Area                            | Failure Mode                                               | User Impact                                                                                          | Priority |
| ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| Repeated cards and proof points in `App` | Array content removed, truncated, or reordered incorrectly | Core messaging disappears while tests still pass                                                     | HIGH     |
| Secondary and final CTA links            | Anchor `href` values drift from section ids                | In-page navigation breaks for users                                                                  | HIGH     |
| Labeled regions                          | `aria-label` values removed or renamed                     | Screen-reader discoverability regresses                                                              | MEDIUM   |
| `src/main.tsx` bootstrap                 | Render entrypoint wiring changes                           | App may fail to mount, but this is usually covered better by build/smoke validation than a unit test | LOW      |
| `src/styles.css` responsive rules        | Layout degrades at mobile widths                           | Visual regression without unit-test signal                                                           | MEDIUM   |

---

## Patterns Referenced

| Test File          | Lines | Pattern                                                                           |
| ------------------ | ----- | --------------------------------------------------------------------------------- |
| `src/App.test.tsx` | 4-24  | Render the page and query user-visible headings and links by accessible role/name |

---

## Positive Observations

The existing test uses Testing Library queries by role and accessible name rather than component internals.
The test passes under the intended runner: `./node_modules/.bin/vitest run`.
The PR already includes a dedicated test setup file for `jest-dom`, so expanding coverage does not require new infrastructure.

---

## Metadata

- **Agent**: test-coverage-agent
- **Timestamp**: 2026-04-11T16:04:30Z
- **Artifact**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/artifacts/runs/b5fc23dc9a7ebf49ee6b5b41f20c5a18/review/test-coverage-findings.md`
