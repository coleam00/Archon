---
title: Publish a plugin
description: Publish Archon workflow packs, forge plugins, and provider plugins on GitHub and list them on archon.diy.
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
provider. For container execution the plugin still inherits the host environment so it
can launch the container runtime; the container request environment travels as session
data and becomes the provider's `options.env`. Credential checks use the plugin process
environment.
The process boundary supplies packaging, crash isolation, and cancellation; it is not a
security sandbox. Archon withholds plugin stderr contents from its logs and errors because
they may contain credentials or user messages.

Native tool specifications travel with the session; their handlers run in the host
through `_archon/tool_call`. Calls after settlement or cancellation are rejected.
`serveProvider` passes a structured log sink to its `create(log)` factory. Await that
sink with `{ level, msg, bindings }` to forward metadata through `_archon/log` to the
host's `provider.<id>` logger. Never put credentials, tokens, or message text in log
records. Keep stdout exclusively for RPC; configure other logging to stderr before
it writes. Stderr remains withheld.

See [building a community provider](/contributing/adding-a-community-provider/) for
`serveProvider`, descriptors, wire schemas, and conformance tests.

Provider receipts are additive, but older Archon binaries reject their unknown kind.
Remove provider plugins before downgrading to a release without provider-plugin support.

## Listing and refresh

Add `archon-plugin` under your repository's About topics. The site searches public repositories with that topic during each build and refreshes daily. It reads manifests from the default branch at one commit, even when the repository also has tags. The displayed latest tag is the first tag returned by GitHub's tags endpoint; it is not a semantic-version ranking or a guarantee that a release asset exists. The install command without a tag follows the installer rules above.

Invalid manifests are skipped with their repository, manifest path, and validation reason in the site build log. Archived repositories remain visible with an archived flag. Listing is discovery, not endorsement or a code review. Maintainers can exclude a repository with a commit to `packages/docs-web/plugin-denylist.json`; entries are `owner/repo`, compared without case, and exclude every plugin in that repository. This affects listing only.

The build uses the read-only Actions `GITHUB_TOKEN` for GitHub API limits. Local site builds can use a token in `GITHUB_TOKEN` or make unauthenticated requests within GitHub's public API limits. No token is required to publish or install a public plugin. GitHub API failures or incomplete search/tree results fail the build rather than replace the catalog with a partial listing.
