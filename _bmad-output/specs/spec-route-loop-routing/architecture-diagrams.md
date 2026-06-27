# Architecture Diagrams

Diagrams are companion content by spec law.
They are illustrative, but the behavior they show is normative where it matches `SPEC.md` and the other companions.

## Core Retry Loop

```mermaid
flowchart LR
  Fix[fix]
  Review[review]
  Router[route_loop: review-router]
  Next[next_step]
  Escalation[escalation]

  Fix --> Review
  Review --> Router
  Router -- positive --> Next
  Router -- negative --> Fix
  Router -- exhausted --> Escalation
```

## Route Decision Algorithm

```mermaid
flowchart TD
  Start[route_loop starts]
  Source[read latest output from from node]
  Eval[evaluate condition]
  ParseFail[fail route_loop]
  TruePath[select positive]
  FalsePath[increment negative counter]
  Budget{negative_count > max_iterations?}
  Negative[select negative]
  Exhausted[select exhausted]
  Event[emit node_routed and set route_loop.output]

  Start --> Source
  Source --> Eval
  Eval -- parse or output reference error --> ParseFail
  Eval -- true --> TruePath
  Eval -- false --> FalsePath
  FalsePath --> Budget
  Budget -- no --> Negative
  Budget -- yes --> Exhausted
  TruePath --> Event
  Negative --> Event
  Exhausted --> Event
```

## Rerun Path Scope

```mermaid
flowchart LR
  Target[negative target]
  A[path node A]
  B[path node B]
  From[from node]
  Router[route_loop]
  Sibling[sibling descendant]
  Exit[exit target]

  Target --> A
  Target --> Sibling
  A --> B
  B --> From
  From --> Router
  Router -- positive or exhausted --> Exit

  classDef rerun fill:#e8f5ff,stroke:#2563eb,color:#111827
  classDef notRerun fill:#f7f7f7,stroke:#9ca3af,color:#374151
  class Target,A,B,From,Router rerun
  class Sibling,Exit notRerun
```

The rerun set is the selected path from the negative target back to `route_loop.from` and then the route loop node.
Sibling descendants outside that selected path do not rerun merely because the negative target reran.
