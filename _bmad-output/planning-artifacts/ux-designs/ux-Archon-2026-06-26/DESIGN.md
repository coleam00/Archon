---
name: Archon Route Loop Routing
description: Visual contract for route_loop authoring and route-aware run review in Archon Web.
status: final
created: 2026-06-26
updated: 2026-06-26
sources:
  - ../../prds/prd-Archon-2026-06-26/prd.md
  - ../../prds/prd-Archon-2026-06-26/addendum.md
colors:
  background: '#15171C'
  surface: '#20232A'
  surface-elevated: '#292D36'
  surface-inset: '#111317'
  surface-hover: '#303541'
  border: '#3A3F4B'
  border-bright: '#555D6B'
  text-primary: '#EDF0F4'
  text-secondary: '#A7AFBB'
  text-tertiary: '#737D8C'
  primary: '#6495ED'
  accent: '#252E4A'
  accent-bright: '#8CB3FF'
  success: '#34D399'
  warning: '#FBBF24'
  error: '#FB7185'
  node-command: '#7C9DFF'
  node-prompt: '#C084FC'
  node-bash: '#FBBF24'
  node-loop: '#2DD4BF'
  node-approval: '#F59E0B'
  route-loop: '#2DD4BF'
  route-loop-muted: '#173B3A'
  not-activated: '#737D8C'
typography:
  body:
    fontFamily: 'var(--font-sans)'
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1.45'
    letterSpacing: '0'
  panel-title:
    fontFamily: 'var(--font-sans)'
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1.35'
    letterSpacing: '0'
  node-title:
    fontFamily: 'var(--font-sans)'
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.25'
    letterSpacing: '0'
  node-badge:
    fontFamily: 'var(--font-sans)'
    fontSize: 9px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: '0'
  mono:
    fontFamily: 'var(--font-mono)'
    fontSize: 10px
    fontWeight: '400'
    lineHeight: '1.4'
    letterSpacing: '0'
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '5': 20px
  '6': 24px
  panel-gutter: 12px
  canvas-grid: 20px
components:
  route-loop-node:
    width: 220px
    min-height: 120px
    background: '{colors.surface}'
    border: '{colors.border}'
    stripe: '{colors.route-loop}'
    badge-background: '{colors.route-loop-muted}'
    badge-foreground: '{colors.route-loop}'
    radius: '{rounded.lg}'
  route-input-port:
    size: 8px
    fill: '{colors.route-loop}'
    label-color: '{colors.text-tertiary}'
  route-output-port-positive:
    size: 8px
    fill: '{colors.success}'
    label-color: '{colors.success}'
  route-output-port-negative:
    size: 8px
    fill: '{colors.warning}'
    label-color: '{colors.warning}'
  route-output-port-exhausted:
    size: 8px
    fill: '{colors.error}'
    label-color: '{colors.error}'
  route-edge-positive:
    stroke: '{colors.success}'
    stroke-width: 1.5px
  route-edge-negative:
    stroke: '{colors.warning}'
    stroke-width: 1.5px
    stroke-dasharray: '6 4'
  route-edge-exhausted:
    stroke: '{colors.error}'
    stroke-width: 1.5px
  not-activated-node:
    border: '{colors.border}'
    foreground: '{colors.not-activated}'
    opacity: '0.58'
  route-decision-row:
    background: '{colors.surface}'
    border: '{colors.border}'
    radius: '{rounded.md}'
---

# Archon Route Loop Routing - Design Spine

## Brand & Style

Route Loop Routing extends Archon as a dense developer workflow tool.
The visual posture stays quiet, precise, and operational.
The feature must read as graph control flow, not as a new product area or a decorative branch diagram.

Archon Web already owns the base visual language through dark-only shadcn, Tailwind tokens, React Flow, compact nodes, and utility panels.
This design spine only adds the Route Loop deltas.
All standard buttons, inputs, tabs, panels, scroll areas, toasts, dialogs, canvas controls, and validation rows inherit the existing Archon Web treatment unless named here.

The Route Loop controller must be visually distinct from the existing AI `loop` node.
`loop` means iterative AI execution.
`route_loop` means route control.
The design must make that distinction visible before the user opens the inspector.

## Colors

The base palette mirrors and inherits from `packages/web/src/index.css`.
No new page palette is introduced.
The feature adds one route-specific accent, `{colors.route-loop}`, for the controller stripe, badge, input port, and route-loop-specific inspector header affordances.

Route outcomes use existing semantic colors.
Positive uses `{colors.success}`.
Negative uses `{colors.warning}` because it is a bounded rerun path rather than a failure.
Exhausted uses `{colors.error}` because it is a terminal control-flow outcome that needs attention, even though the workflow may complete.
Never-activated nodes use `{colors.not-activated}` with muted opacity so they are visibly different from skipped, pending, and failed nodes.

Do not create a rainbow graph.
Only the controller and selected route outputs carry the route colors.
Normal dependency edges and non-route nodes keep the current Archon Web styles.

## Typography

Typography inherits the current Inter and JetBrains Mono tokens.
Route Loop UI uses the same compact type scale as the existing workflow builder.
Node badges use `{typography.node-badge}`.
Node titles use `{typography.node-title}`.
Expression previews, node IDs, output references, and event metadata use `{typography.mono}`.

Letter spacing stays `0`.
Do not add new tracked uppercase labels for Route Loop beyond the existing node-library and inspector conventions.
Long labels wrap inside inspector rows and truncate inside graph nodes only when the full value is available through title text or a detail panel.

## Layout & Spacing

The builder remains a three-zone tool: node library, React Flow canvas, and node inspector.
Route Loop must fit this existing frame.
The controller node may be wider than existing executable nodes because it carries three outcome ports, but its dimensions must remain fixed and predictable.
Use `{components.route-loop-node.width}` and `{components.route-loop-node.min-height}` as the target size.

Outcome ports are stacked on the right edge in the order `positive`, `negative`, `exhausted`.
The single input port stays centered on the top edge to match existing DAG input reading direction.
Port labels sit close enough to the port to identify the route while avoiding edge overlap.

Run detail remains split between graph and logs.
Route decision detail should sit in the existing logs or event-detail lane rather than adding a new analytics page.

## Elevation & Depth

Depth follows the existing Archon surface hierarchy.
Route Loop nodes use `{colors.surface}` with a normal border.
Selected nodes use the existing primary ring behavior.
Running route-loop or selected-route emphasis may use the existing subtle glow style, but it must not pulse every outcome port at once.

Dialogs and validation panels inherit shadcn elevation.
Do not add floating cards on top of the canvas for route metadata when the inspector or event panel can carry the same information.

## Shapes

Route Loop surfaces use the existing radius scale.
Node containers use `{rounded.lg}`.
Inspector fields and event rows use `{rounded.md}`.
Status chips may use `{rounded.full}` only when they follow existing badge conventions.

Ports remain small circular handles.
Do not use custom novelty shapes for route outcomes.

## Components

### Route Loop Node

The Route Loop node is a controller card with a left stripe in `{colors.route-loop}`.
Its badge text is `ROUTE`.
Its title is the node ID or friendly label.
Its metadata pills show `condition`, `max_iterations`, `from`, and any missing route count when invalid.
The node does not show provider, model, tool, or execution metadata because it does not call an agent or process.

### Route Outcome Ports

Each output port is labeled with the exact public route outcome: `positive`, `negative`, and `exhausted`.
Labels are always visible on the node.
Color reinforces meaning, but the label carries the meaning.
The positive port uses `{components.route-output-port-positive.fill}`.
The negative port uses `{components.route-output-port-negative.fill}`.
The exhausted port uses `{components.route-output-port-exhausted.fill}`.

### Route Edges

Normal dependency edges keep the current neutral stroke.
Route output edges use the outcome color only when the edge originates from a Route Loop output port.
The negative route edge may use `{components.route-edge-negative.stroke-dasharray}` to signal rerun behavior without implying failure.
Selected runtime route edges in run detail may be highlighted for the latest route decision.

### Not Activated Node

`not_activated` is not pending and not skipped.
Its graph node uses `{components.not-activated-node.foreground}`, muted opacity, and a text label of `not_activated`.
Do not use the skipped icon, skipped opacity alone, or pending spinner for this state.

### Route Decision Row

Route decision rows are compact audit rows.
They show outcome, target, condition result, negative count, max iterations, attempt, and execution sequence.
The outcome color may appear as a small leading swatch, but the outcome text is always present.

## Do's and Don'ts

| Do                                                    | Don't                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| Inherit Archon Web shadcn and Tailwind tokens.        | Create a separate Route Loop visual theme.                 |
| Make `route_loop` visually distinct from AI `loop`.   | Reuse the AI loop badge, stripe, or execution metadata.    |
| Show all three route labels on the node.              | Hide outcomes behind unlabeled handles or condition text.  |
| Use semantic colors for route outcomes.               | Encode outcomes with color alone.                          |
| Show `not_activated` as its own state.                | Collapse it into skipped, pending, or hidden.              |
| Keep run summary compact and latest-attempt-only.     | Render every attempt as a separate node in the main graph. |
| Put detailed route metadata in the event/log surface. | Add a new route analytics page for v1.                     |
