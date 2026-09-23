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
`workflow` sub-run nodes. Use YAML for workflows that contain those forms.

Use the builder to draft new workflows from the supported node forms, validate
them, and inspect the generated YAML. Editing an existing workflow and relying on
a load/edit/save round trip is not supported until
[#3378](https://github.com/coleam00/Archon/pull/3378) and
[#3379](https://github.com/coleam00/Archon/pull/3379) land. Edit existing
workflows as YAML. Bundled workflows open read-only. The editor warns about
unsaved changes on reload and on its own navigation controls. Browser Back and
navigation through the project rail do not currently run that guard.

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

## Current round-trip limit

The unit fixtures exercise conversion for the builder's supported generated
shape. They do not prove a lossless round trip for existing authored workflow
files. The normalized loader can discard authored structure, including fields
the builder does not represent. Use YAML to edit existing workflows until the
linked fixes land. Canvas positions are UI state and never enter workflow YAML.

Generated YAML normalizes key order. Workflow names are tied to their filenames.
Workflows in nested `.archon/workflows/` directories cannot be loaded through
the single-name route.
