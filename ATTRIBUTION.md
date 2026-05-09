# Attribution

bdc-harness is a fork of [coleam00/Archon](https://github.com/coleam00/Archon), used under the MIT License.

Fork point: `f4f27255` (coleam00/Archon dev branch, 2026-05-09)

## BDC-specific changes

- `packages/workflows/src/executor-shared.ts`: added `${run.id}` substitution in bash blocks
- `packages/workflows/src/schemas/loop.ts`: changed `fresh_context` default from `false` to `true`
- `packages/workflows/src/executor.ts`: added `claude-sonnet-4-5` as fallback model default
- `README.md`: rebranded to bdc-harness, credited upstream

## Original license

MIT License — Copyright (c) coleam00. Full license text: [LICENSE](./LICENSE)
