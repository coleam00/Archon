# Find existing work

Read only. Never create, edit, close, comment on, or label tracker items.
Read $ARTIFACTS_DIR/discoveries/normalized.json, discoveries/context.json,
and evidence-check.json under the same artifact root.

If context.forge.available is false, do not call a forge CLI. Return
forge_checked: false and matches: [] for each item. GitHub.com through gh
is the supported read adapter in this slice; other origins remain local.

Otherwise, for every item not disproved, use gh scoped explicitly to
context.forge.host/context.forge.path. Read a paginated list of issues and
pull requests, including closed work, for the exact HTML marker
<!-- archon-discovery:MARKER --> using the item's marker. Then search and
read semantically related work. Judge the underlying problem, not shared
words. Only include matches you judge to cover the same or closely related
work. If reads are incomplete or fail, say forge_checked: false and return
no matches; an incomplete search is not evidence of new work.

Return an object with entries, exactly one per item_index:
- forge_checked: whether you completed the marker and semantic reads
- matches: number, url, title, and similarity_note for each relevant item

Disproved items may use forge_checked: false and matches: [].
