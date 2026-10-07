---
title: Publish a plugin
description: Publish Archon workflow packs, forge plugins, provider plugins, and chat plugins on GitHub and list them on archon.diy.
---

GitHub is the registry. Publish in your own public repository, then add the `archon-plugin` repository topic to appear in the [plugin index](/plugins/). No Archon pull request, Archon account, or publication service is required. Listing is optional: `archon plugin install owner/repo[/path][@tag]` works independently of the index.

## Workflow packs

Place `archon-plugin.json` in your plugin root, either the repository root or a subdirectory. A repository can contain several plugins. Each manifest-bearing directory gets its own listing and install ID, such as `acme/tools/packs/review-kit`.

```json
{
  "schemaVersion": 1,
  "kind": "workflow-pack",
  "name": "review-kit",
  "description": "Review workflows",
  "compatibility": { "archon": ">=0.11.0" },
  "entrypoints": { "review": "review/review.yaml" }
}
```

Use lowercase words joined by hyphens for `name` and entrypoint names. Each entrypoint path is `<workflow folder>/<file>.yaml` (or `.yml`), relative to the plugin root. Other workflows are support workflows and cannot be dispatched directly. See the [pack layout and runtime identity](/guides/global-workflows/#installed-workflow-packs).

The manifest is strict. Do not add version, credentials, install scripts, dependencies, or permission grants. `compatibility.archon` is optional; when supplied, installation checks it. Put prerequisites and usage instructions in a `README.md` alongside the manifest. The index links to the README on GitHub; it does not execute plugin code or embed author-supplied HTML.

## Tags and executable release assets

Git tags are versions. For workflow packs, an untagged install resolves the default branch head and freezes its commit. Publish a tag to let operators choose a version:

```bash
archon plugin install acme/tools/packs/review-kit@v1.0.0
```

A forge plugin declares an executable instead of workflow entrypoints:

```json
{
  "schemaVersion": 1,
  "kind": "forge",
  "name": "example-forge",
  "description": "Example forge integration",
  "executable": "archon-forge-example"
}
```

Publish a GitHub release with `<executable>-<os>-<arch>` assets (`.exe` on Windows), and `checksums.txt` in `sha256sum` format covering the asset names. Supported platform names are `linux`, `darwin`, and `windows`; architectures are `x64` and `arm64`. Build assets for the platforms you support. An untagged forge install uses the latest GitHub release. A tag without the required platform asset cannot install on that platform. Checksums detect damaged downloads; they do not establish publisher trust.

## Provider plugins

A provider plugin runs agent sessions in a separate process. Publish the implementation
in your own repository with this manifest at its root or an installable subdirectory:

```json
{
  "schemaVersion": 1,
  "kind": "provider",
  "name": "example-provider",
  "description": "Example agent provider",
  "executable": "archon-provider-example",
  "compatibility": { "archon": ">=0.11.1" }
}
```

The executable suffix is the provider id: `archon-provider-example` must return
`id: "example"` in its descriptor. Publish release assets and `checksums.txt` with
the same naming rules as forge plugins, for example `archon-provider-example-linux-x64`
and `archon-provider-example-windows-x64.exe`. Without `@tag`, install and update
select the latest GitHub release.

```sh
archon plugin install owner/repo
archon plugin list
archon plugin update owner/repo
archon plugin remove owner/repo
```

Install verifies the checksum, starts the staged executable, validates its descriptor,
and records that descriptor in the receipt. An invalid handshake, id collision,
unsupported capability, or undeliverable API-key vendor leaves the previous install
unchanged. Hosts register receipts without starting the executables at boot; each
session checks the live descriptor against the installed one. Restart a running server
after installing, updating, or removing a provider. A new CLI process sees it immediately.
A workflow can then name the descriptor id in `provider:`.

Provider plugins execute code as your operating-system user. On the host they receive
the ambient environment plus Archon's per-request environment, just like an in-process
provider. For container execution they receive the minimal container environment plus
the request environment. Credentials use that process environment, not protocol fields.
The process boundary supplies packaging, crash isolation, and cancellation; it is not a
security sandbox. Archon withholds plugin stderr contents from its logs and errors because
they may contain credentials or user messages.

See [building a community provider](/contributing/adding-a-community-provider/) for
`serveProvider`, descriptors, wire schemas, and conformance tests.

Provider receipts are additive, but older Archon binaries reject their unknown kind.
Remove provider plugins before downgrading to a release without provider-plugin support.

## Chat plugins

A chat plugin declares an `archon-chat-*` executable:

```json
{
  "schemaVersion": 1,
  "kind": "chat",
  "name": "example-chat",
  "description": "Example chat integration",
  "executable": "archon-chat-example"
}
```

Publish release assets and `checksums.txt` with the same platform naming rules as
forge and provider plugins, for example `archon-chat-example-linux-x64` and
`archon-chat-example-windows-x64.exe`. Do not put `.exe` in the manifest.

```sh
archon plugin install owner/repo@v1.0.0
archon plugin list
archon plugin update owner/repo
archon plugin remove owner/repo
```

Without a tag, install and update use the latest GitHub release. After checksum
verification, Archon starts the staged executable, sends only `initialize`, validates
its `archon-chat/1` descriptor, and stops the process before recording the install.
Initialization has a ten-second deadline and must work without chat credentials or
`chat/start`. The receipt records the descriptor, release tag, commit, and binary digest.
The descriptor's platform id is independent of the manifest name and executable suffix.

The wire uses newline-delimited JSON-RPC 2.0 on stdin/stdout. For an initialize
request such as `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
reply with the same request id and a descriptor as `result`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocol": "archon-chat/1",
    "id": "example-chat",
    "displayName": "Example chat integration",
    "version": "1.0.0",
    "capabilities": {
      "defaultWorkflowDispatch": "foreground"
    },
    "policy": {
      "workspaceRetention": "age-based"
    }
  }
}
```

Write the response as one JSON line followed by a newline; the example is expanded
for readability. Keep stdout for protocol messages. The generated
[chat contract schema](https://github.com/coleam00/Archon/blob/dev/packages/chat-contract/schema/chat-contract.schema.json)
defines `ChatPluginDescriptor` and the other wire payloads under `$defs`, including
optional descriptor fields. TypeScript plugins can use
[`serveChat` from `@archon/chat-contract`](https://github.com/coleam00/Archon/tree/dev/packages/chat-contract)
to handle initialization and framing.

A platform id cannot belong to two chat installs. `web`, `cli`, `api`, `github`,
`gitea`, and `gitlab` are reserved for host surfaces and bundled forge adapters.
Collisions name both owners. A rejected initialization or collision leaves existing
files unchanged; handled publication failures restore the previous install when the
filesystem permits rollback. A rollback failure reports local recovery and backup paths.
Installation does not promise crash atomicity across receipt and binary files.

Chat plugins run as your operating-system user and inherit the ambient environment.
Plugin stderr and plugin-controlled error details are withheld because they may contain
credentials or user messages. The process boundary is not a security sandbox.

Chat installation currently records the binary and descriptor only. Running hosts do not
yet load these chat plugins; installing one does not replace a bundled chat adapter.
Remove chat installs before downgrading to an Archon release without chat receipts.

## Listing and refresh

Add `archon-plugin` under your repository's About topics. The site searches public repositories with that topic during each build and refreshes daily. It reads manifests from the default branch at one commit, even when the repository also has tags. The displayed latest tag is the first tag returned by GitHub's tags endpoint; it is not a semantic-version ranking or a guarantee that a release asset exists. The install command without a tag follows the installer rules above.

Invalid manifests are skipped with their repository, manifest path, and validation reason in the site build log. Archived repositories remain visible with an archived flag. Listing is discovery, not endorsement or a code review. Maintainers can exclude a repository with a commit to `packages/docs-web/plugin-denylist.json`; entries are `owner/repo`, compared without case, and exclude every plugin in that repository. This affects listing only.

The build uses the read-only Actions `GITHUB_TOKEN` for GitHub API limits. Local site builds can use a token in `GITHUB_TOKEN` or make unauthenticated requests within GitHub's public API limits. No token is required to publish or install a public plugin. GitHub API failures or incomplete search/tree results fail the build rather than replace the catalog with a partial listing.
