---
name: Archon Route Loop Routing
status: final
created: 2026-06-26
updated: 2026-06-26
sources:
  - ../../prds/prd-Archon-2026-06-26/prd.md
  - ../../prds/prd-Archon-2026-06-26/addendum.md
---

# Archon Route Loop Routing - Experience Spine

## Foundation

Single-surface responsive web.
The in-scope product surfaces are the production Archon Web workflow builder and the workflow run detail view.
The UI system is existing Archon Web: React, shadcn/ui, Tailwind CSS, React Flow, dark-only theme tokens, and compact developer-tool panels.
`DESIGN.md` is the visual identity reference.
This spine defines behavior, information architecture, states, interaction rules, accessibility, and journeys.

Route Loop Routing is a controlled workflow authoring and observability feature.
It is not a general graph-cycle editor.
The UX must preserve Archon's DAG-first mental model while making bounded route decisions visible.

Composition reference: [route-loop-builder.html](mockups/route-loop-builder.html).
The spines win on conflict with the mockup.

## Information Architecture

| Surface                         | Reached from                               | Purpose                                                                               |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Workflow builder canvas         | Workflows -> Builder                       | Author the DAG and visually connect Route Loop input and route outputs.               |
| Node library and quick add      | Builder left panel or canvas double-click  | Add executable nodes and Route Loop controller nodes.                                 |
| Route Loop inspector            | Select a Route Loop node                   | Edit condition, max_iterations, synchronized From Node, and route target fields.      |
| Validation panel and status bar | Builder footer, save, run, or validate     | Explain route-loop-specific invalid states and focus the affected node.               |
| YAML split and full view        | Builder toolbar                            | Show serialized `route_loop` contract without becoming the primary authoring surface. |
| Workflow run detail graph       | Run Details -> Graph                       | Show latest node state, selected route edge, and `not_activated` route-capable nodes. |
| Event and logs panel            | Run detail split panel or Logs tab         | Show `node_routed`, attempt history, condition results, counters, and errors.         |
| Retry action panel              | Failed run detail with selected node       | Retry eligible failed nodes and block direct retry of Route Loop controllers.         |
| Secondary builder surfaces      | Any surface that can save or run workflows | Fully round-trip Route Loop or block unsupported editing without dropping fields.     |

IA closes when every stated Route Loop need has a surface.
Authoring lives in the builder canvas and inspector.
Validation lives in the validation panel and server validation response.
Runtime route evidence lives in run detail graph plus logs.
Attempt history lives in event detail, not in the main graph summary.

## Mock Coverage

| Surface                         | Coverage                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| Workflow builder canvas         | Mocked in [route-loop-builder.html](mockups/route-loop-builder.html).                            |
| Node library and quick add      | Mocked for Route Loop entry point in [route-loop-builder.html](mockups/route-loop-builder.html). |
| Route Loop inspector            | Mocked in [route-loop-builder.html](mockups/route-loop-builder.html).                            |
| Validation panel and status bar | Mocked for the no-error state in [route-loop-builder.html](mockups/route-loop-builder.html).     |
| YAML split and full view        | Spine-only.                                                                                      |
| Workflow run detail graph       | Spine-only.                                                                                      |
| Event and logs panel            | Spine-only.                                                                                      |
| Retry action panel              | Spine-only.                                                                                      |
| Secondary builder surfaces      | Spine-only until architecture decides which surfaces upgrade or block editing.                   |

Spine-only surfaces are fully specified by the tables and state rules in this document.
The mockup is illustrative and does not override the spines.

## Voice and Tone

Microcopy is precise, short, and stateful.
It should name the actual invariant or route outcome rather than explain the concept broadly.

| Do                                                   | Don't                                  |
| ---------------------------------------------------- | -------------------------------------- |
| `Missing positive route for review-router.`          | `This loop is not complete.`           |
| `Route target is already running: fix.`              | `Could not continue.`                  |
| `not_activated`                                      | `Skipped`                              |
| `Exhausted route selected after 10 negative passes.` | `Loop failed.`                         |
| `Retry selected route path.`                         | `Retry selected node and descendants.` |
| `Condition parse failed. No route was selected.`     | `Negative route selected by default.`  |

Use exact public terms: `route_loop`, `positive`, `negative`, `exhausted`, `from`, `max_iterations`, `negative_count`, and `node_routed`.
Do not introduce friendly aliases that make YAML, runtime output, and UI disagree.

## Component Patterns

Behavioral rules live here.
Visual specs live in `DESIGN.md.Components`.

| Component            | Use                   | Behavioral rules                                                                                                                              |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Route Loop node      | Builder and run graph | Controller only. One input, three labeled outputs, no provider tools, no prompt fields, no AI loop fields.                                    |
| Input port           | Builder canvas        | Accepts exactly one incoming edge. Connecting it sets both `depends_on` and `route_loop.from`. Reconnecting replaces the synchronized source. |
| Outcome ports        | Builder canvas        | `positive`, `negative`, and `exhausted` each accept one target edge and serialize into the matching `route_loop.routes` key.                  |
| Route target fields  | Inspector             | Mirror the canvas connections and allow correction only if they can keep route edge state, route target, and YAML in sync.                    |
| Condition field      | Inspector             | Uses the existing condition grammar. Validation copy says route-loop parse errors fail the controller.                                        |
| Max iterations field | Inspector             | Numeric input with visible default of `10` and bounds of `1` through `100`.                                                                   |
| Validation issue     | Validation panel      | Blocks save and run for missing routes, mismatched From Node, second input edge, self-target route, and unsupported mixed mode.               |
| Route decision row   | Run detail logs       | Shows route outcome, target, condition, condition_result, negative_count, max_iterations, attempt, and execution sequence.                    |
| Attempt chip         | Run graph and logs    | Shows latest attempt count when the node has run more than once. Opens detailed event history when activated.                                 |
| Retry action         | Failed run detail     | Hidden for Route Loop controllers. For nodes inside a route loop, says selected route path when route-aware retry is active.                  |

## State Patterns

| State                           | Surface                | Treatment                                                                                                        |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| New Route Loop node             | Builder canvas         | Show controller node with empty route metadata pills and three unconnected outcome ports.                        |
| Missing input                   | Builder validation     | Error names the Route Loop node and says one input edge is required.                                             |
| Second input attempted          | Builder canvas         | Reject the connection and keep focus on the existing input edge or Route Loop node.                              |
| Missing route target            | Builder validation     | Error names the missing route outcome and blocks save and run.                                                   |
| Shared route target             | Builder canvas         | Allowed when engine validation passes. Do not warn solely because negative and exhausted share a target.         |
| Condition references other node | Builder validation     | Error names the invalid reference and says Route Loop conditions can reference only the From Node.               |
| Condition parse error           | Runtime and validation | Route Loop fails. No negative count is burned. No route is selected.                                             |
| From Node unusable              | Runtime detail         | Route Loop fails fast and explains skipped, failed, pending, missing, or no-output source state.                 |
| Positive route selected         | Run graph and logs     | Highlight positive route edge and show completed controller output metadata.                                     |
| Negative route selected         | Run graph and logs     | Highlight negative route edge, increment negative_count, and show fresh attempts on the selected path.           |
| Exhausted route selected        | Run graph and logs     | Highlight exhausted route edge and show completed control flow with `condition_result: false`.                   |
| Not activated target            | Run graph              | Show `not_activated` label and muted visual treatment. Do not list as executed.                                  |
| Older attempts                  | Run logs               | Preserve chronological history with attempt and execution sequence metadata.                                     |
| Route audit persistence failure | Runtime detail         | Controller fails before target activation and names the route evidence persistence problem.                      |
| Resume after pause or failure   | Run detail             | Preserve activation state, negative_count, attempt counters, selected route state, and latest effective outputs. |

## Interaction Primitives

Pointer interaction follows the current React Flow builder.
Users drag Route Loop from the node library or create it from quick add.
Users connect the top input edge from the From Node.
Users connect each labeled outcome port to a real target node.

Keyboard interaction must provide parity for route authoring.
Users can create a Route Loop node without drag and drop.
Users can focus a Route Loop node, open the inspector, edit fields, select route targets, and move through validation issues using the keyboard.
Users can inspect route decision rows and attempt history without relying on canvas hover.

Connection rules must be immediate and explicit.
A second input edge is rejected at connection time.
Missing outcome edges are validation errors that block save and run.
Route output edges must preserve their port identity during drag, reconnect, undo, redo, layout, save, load, YAML split view, and generated API type round trip.

Builder validation is helpful but not authoritative.
The server and engine remain authoritative.
When client validation and server validation disagree, the UI shows the server error and keeps the user on the affected node or route field.

## Accessibility Floor

WCAG 2.2 AA is the floor for the responsive web surface.
Contrast follows `DESIGN.md` tokens and the inherited shadcn defaults.
Every interactive Route Loop control has a visible focus ring.

Route outcomes must not rely on color alone.
Each port has a visible text label.
Each selected route event has an outcome label in text.
Each run graph state has a text label available in the node or detail panel.

Screen readers announce route ports as node-scoped controls.
Recommended labels are `review-router positive route`, `review-router negative route`, and `review-router exhausted route`.
`not_activated` is announced as `not activated`, not skipped.

The graph needs a list-backed alternative path for route inspection.
The validation panel, inspector, and event/log panel must expose all information required to author and debug a Route Loop without spatial canvas interpretation.

Keyboard focus order follows the visible surface order.
In builder: toolbar, node library, canvas selection, inspector, validation panel, status bar.
In run detail: header, view tabs, graph, selected-node detail, logs, retry panel.
Escape closes only the topmost popover, dialog, quick add, or active field edit.

## Responsive & Platform

Primary authoring target is desktop and laptop web.
Route Loop authoring is graph-heavy and should be optimized first for wide screens.

| Breakpoint     | Behavior                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `>= 1024px`    | Node library, canvas, inspector, validation panel, and optional YAML split view can be visible together.               |
| `768px-1023px` | Inspector and node library may collapse, but route labels and validation remain visible.                               |
| `< 768px`      | Viewing and small edits are supported. Complex route authoring uses full-screen panels or focused inspector workflows. |

Do not hide required route outcomes on smaller screens.
If the canvas cannot comfortably show all labels, the inspector must show the complete route table.

## Runtime Observability Contract

Run detail must make route decisions inspectable without guessing from node order.
The latest selected route is visible on the graph.
Every `node_routed` event is visible in chronological event detail.
The main graph shows latest node state only.
Older attempts remain accessible through logs and event detail.

The Route Loop output shown to downstream authors is the six-field v1 output contract: `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`.
Route Loop node ID and From Node ID are shown in `node_routed` event detail when provided by the event metadata.
The UI should not invent optional output fields.

## Inspiration & Anti-patterns

Lift from Linear-style operational density: state labels are compact, precise, and easy to scan.
Lift from existing Archon Web: dark surface, compact graph cards, small badges, route-free DAG nodes unchanged.
Lift from workflow engines that keep branches explicit: routes are visible ports and named outcomes.

Reject hidden routing.
Reject unlabeled handles.
Reject a general cyclic graph editor.
Reject coloring unselected branches as skipped.
Reject rendering every attempt as a separate main-graph node.

## Key Flows

### Flow 1 - Ana authors a route loop visually

1. Ana opens the production workflow builder for a BMAD review workflow.
2. She adds `fix`, `review`, and `review-router`.
3. She changes `review-router` to Route Loop or adds it directly from quick add.
4. She connects `review` into the Route Loop input, which synchronizes `depends_on` and `route_loop.from`.
5. She enters `$review.output.result == 'positive'` and leaves max_iterations at the visible default of `10`.
6. She connects `positive` to the next step, `negative` to `fix`, and `exhausted` to escalation.
7. The validation panel clears route-loop-specific errors.
8. Climax: Save and Run become available, and the YAML split view shows the exact `route_loop.routes` keys she just connected.

Failure: Ana leaves `exhausted` unconnected.
The validation panel says `Missing exhausted route for review-router.` and focuses the Route Loop node.

### Flow 2 - Kevin watches a failed review route back to fix work

1. Kevin starts the workflow from the Web UI.
2. The run detail graph shows `fix`, `review`, and `review-router` as normal nodes until the first review completes.
3. The Route Loop evaluates false.
4. The graph highlights the `negative` route edge to `fix`.
5. The logs show a `node_routed` row with condition, condition_result, negative_count, max_iterations, attempt, and execution sequence.
6. `fix` and the selected path run again as fresh attempts.
7. Climax: the second review produces a positive result, the graph highlights the `positive` route edge, and the summary still shows only the latest attempt for each node.

Failure: route audit evidence cannot persist.
The controller fails before activating `fix`, and Kevin sees a route evidence error rather than a hidden rerun.

### Flow 3 - Mira debugs an exhausted quality gate

1. Mira opens a completed run that ended through exhausted control flow.
2. The main graph shows the latest attempt for each node and an exhausted route edge.
3. Unselected targets show `not_activated` rather than skipped.
4. She opens logs for `review-router`.
5. She sees every route decision with negative_count and execution sequence.
6. She confirms `$review.output` points to the latest completed review attempt.
7. Climax: Mira can explain why the loop stopped without reconstructing behavior from raw node order.

Failure: the condition referenced an undeclared output field.
The Route Loop row shows a controller failure and no negative route was selected.

### Flow 4 - Riley validates route editing without a mouse

1. Riley opens the builder and tabs to quick add.
2. Riley creates a Route Loop node and opens the inspector.
3. Riley selects the From Node and each route target from keyboard-operable controls.
4. Riley tabs to the condition field, enters the expression, and validates.
5. The validation panel reports no route-loop errors.
6. Climax: Riley saves the workflow without drag-and-drop being required for the final route contract.

Failure: Riley selects the same Route Loop as a route target.
The validation panel names the invalid self-target and keeps focus on the route target field.

## Open UX Questions

These are not blockers for the v1 UX spine.
They should be resolved during architecture or story breakdown.

1. Should a negative route directly targeting the From Node appear as a builder warning, documentation warning, or both?
2. Which secondary builder surfaces must ship full Route Loop support in the same release, and which should block unsupported editing?
3. Should Route Loop route target fields be editable as a table in the inspector, or should inspector edits only launch target pickers that preserve canvas edge identity?
4. Should run detail display only the six required `route_loop.output` fields, or also show optional event metadata when architecture exposes it?
