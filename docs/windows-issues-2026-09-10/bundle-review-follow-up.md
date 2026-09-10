# Bundle collector review follow-up

Both important review findings are addressed in current source.

- `entryType` dereferences symbolic-link Dirents via `stat`; every affected non-shared directory/file selection branch calls it. Shared module links retain their explicit rejection.
- `validateDefaultName` restores the strict lowercase kebab-case guard for default YAML (including legacy) and default commands. Packaged names keep the previous validator.

Verified on Windows with Bun 1.4.2 revision 744846f84:

| Check | Result | Evidence |
| --- | --- | --- |
| Current collector test file | 4 pass, 0 fail, 13 assertions; 76ms | bundle-inventory-review-baseline.log |
| In-memory mutation: return raw Dirent from entryType | Expected failure: linked workflow inventory was [] instead of the two runtime paths; exit 1, 70ms | bundle-review-skip-link-dereference.log |
| In-memory mutation: broad default-name validator | Expected failures: __proto__.yaml and Uppercase.md resolved instead of rejecting; exit 1, 67ms | bundle-review-broad-default-names.log |

Mutations were applied only through Bun.plugin's onLoad hook in bundle-review-mutations.ts; no repository source edits occurred. Each log records the mutation being loaded and the actual assertion failure, so an unrelated import failure cannot count as sensitivity proof. The two reviews no longer block on these findings. This does not replace the broader planned runtime/generator checks.
