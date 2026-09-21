# Workflow builder

The workflow builder is an experimental authoring surface inside the Archon
console. `/console/builder` selects a project and workflow;
`/console/builder/:name?project=<id>` opens the editor.

## Supported editing surface

The builder provides a React Flow canvas, node palette, inspector, validation
panel, and read-only YAML preview. It directly represents these node variants:

- prompt
- command
- bash
- script
- loop
- approval
- wait
- cancel

The builder does not represent include directives, `loop_group` nodes, or
`workflow` sub-run nodes. Edit workflows that use those forms as YAML. Import
issues also report fields the current model cannot preserve. Treat the YAML file
as the authoritative workflow definition and review the preview before saving.

Project workflows can be created, loaded, validated, renamed, saved, and
deleted. Bundled workflows open read-only and can be saved as a project override.
The editor warns about unsaved changes on reload and on its own navigation
controls. Browser Back and navigation through the project rail do not currently
run that guard.

## Ownership

- `types/` owns builder and generated wire type aliases.
- `variants/` converts each supported node variant.
- `model/` imports and exports workflow definitions.
- `validation/` performs synchronous client validation.
- `flow/`, `editor/`, and `yaml/` contain pure canvas, history, and serialization
  logic.
- `components/` and `BuilderPage.tsx` render the controlled editor.
- `BuilderConnected.tsx` and `connect/` own project selection, API calls, and
  navigation.

Runtime API calls go through console skills, and reactive server state goes
through `store/cache.ts`. Generated API shapes are imported type-only through
`types/wire.ts`.

The builder's unit tests focus on pure conversions, validation, serialization,
history, clipboard, and layout logic. `/console/_preview` provides fixture-backed
visual examples.

## Round-trip contract

Supported fixtures satisfy
`toWorkflowDefinition(fromWorkflowDefinition(fixture)) === fixture`. The engine
emits sparse nodes, and the exporter preserves that shape. Canvas positions are
UI state and never enter workflow YAML.

Saving normalizes YAML key order, so a correct save can still produce a textual
diff. Workflow names are tied to their filenames. Workflows in nested
`.archon/workflows/` directories cannot be loaded through the single-name route.
