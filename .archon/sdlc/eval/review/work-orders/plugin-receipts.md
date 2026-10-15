# Malformed receipts also block the existing plugin repair commands

Plugin update and remove read all receipts before acting, so a receipt that fails JSON or schema validation prevents those commands from repairing or removing it. This behavior predates the reviewed slice.

## Evidence

- packages/cli/src/commands/plugin.ts:717 at starting commit c5a5bd306 reads receipts before update acts
- packages/cli/src/commands/plugin.ts:745 at starting commit c5a5bd306 reads receipts before remove selects or removes files
- packages/plugin-manifest/src/store.ts:54 and :60 throw for malformed JSON and schema-invalid receipts

Found while delivering an earlier pull request (Archon run `3daedf324d1b5b9706b4ddb7d19d0fcc`, recorded by implement). The run filed it instead of fixing it in that change.
