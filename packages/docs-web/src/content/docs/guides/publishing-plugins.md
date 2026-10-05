---
title: Publish a plugin
description: Publish Archon workflow packs and forge plugins on GitHub and list them on archon.diy.
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

## Listing and refresh

Add `archon-plugin` under your repository's About topics. The site searches public repositories with that topic during each build and refreshes daily. It reads manifests from the default branch at one commit, even when the repository also has tags. The displayed latest tag is the first tag returned by GitHub's tags endpoint; it is not a semantic-version ranking or a guarantee that a release asset exists. The install command without a tag follows the installer rules above.

Invalid manifests are skipped with their repository, manifest path, and validation reason in the site build log. Archived repositories remain visible with an archived flag. Listing is discovery, not endorsement or a code review. Maintainers can exclude a repository with a commit to `packages/docs-web/plugin-denylist.json`; entries are `owner/repo`, compared without case, and exclude every plugin in that repository. This affects listing only.

The build uses the read-only Actions `GITHUB_TOKEN` for GitHub API limits. Local site builds can use a token in `GITHUB_TOKEN` or make unauthenticated requests within GitHub's public API limits. No token is required to publish or install a public plugin. GitHub API failures or incomplete search/tree results fail the build rather than replace the catalog with a partial listing.
