# SBOM Requirements Reference

Federal SBOM minimum elements and format requirements for `generate_sbom.py`.

## Minimum Elements (NTIA)

Per NTIA "Minimum Elements for a Software Bill of Materials" and OMB M-22-18:

| Field | Description | Required |
|-------|-------------|----------|
| Supplier Name | Entity that creates/distributes the component | Yes |
| Component Name | Package name as defined by the supplier | Yes |
| Version | Version identifier | Yes |
| Unique Identifier | purl (package URL) preferred | Yes |
| Dependency Relationship | Direct vs transitive | Yes |
| Author of SBOM Data | Entity that generated the SBOM | Yes |
| Timestamp | Date/time of SBOM generation | Yes |

Optional but recommended: license, hash/checksum, download URL.

## Supported Formats

| Format | Schema Version | MIME Type | Priority |
|--------|---------------|-----------|----------|
| CycloneDX JSON | 1.5 | application/vnd.cyclonedx+json | Primary |
| SPDX JSON | 2.3 | application/spdx+json | Alternative |

CycloneDX is preferred for federal use due to broader tooling support and VEX integration.

## Tool Detection Order

`generate_sbom.py` attempts tools in this order, using the first available:

1. `syft` — broadest language support, produces CycloneDX/SPDX natively
   - Check: `syft --version`
   - Command: `syft {project_dir} -o cyclonedx-json`
2. `cyclonedx-py` (Python projects) — pip/poetry/pipenv support
   - Check: `cyclonedx-py --version`
   - Command: `cyclonedx-py requirements -i requirements.txt -o sbom.json --format json`
3. `cyclonedx-npm` (Node projects) — npm/yarn support
   - Check: `npx @cyclonedx/cyclonedx-npm --version`
   - Command: `npx @cyclonedx/cyclonedx-npm --output-file sbom.json`
4. Manual fallback — parse dependency files directly into CycloneDX 1.5 JSON
   - No transitive dependencies (direct only)
   - Limited license detection
   - Logs warning about reduced coverage

## Dependency File Detection

| File | Language/Ecosystem | Parser |
|------|--------------------|--------|
| `requirements.txt` | Python (pip) | Line-based: `package==version` |
| `Pipfile.lock` | Python (pipenv) | JSON: `default` and `develop` keys |
| `poetry.lock` | Python (poetry) | TOML: `[[package]]` sections |
| `package.json` | JavaScript (npm/yarn) | JSON: `dependencies` and `devDependencies` |
| `package-lock.json` | JavaScript (npm) | JSON: `packages` key (npm v7+) |
| `pom.xml` | Java (Maven) | XML: `<dependency>` elements |
| `build.gradle` | Java (Gradle) | Regex: `implementation`, `api`, `compile` |
| `go.mod` | Go | Line-based: `require` block |
| `go.sum` | Go | Line-based: `module version hash` |

## CycloneDX 1.5 Minimal Structure (for fallback)

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": {
    "timestamp": "2026-04-03T14:00:00Z",
    "tools": [{"name": "ssdf-development", "version": "1.0"}],
    "component": {
      "type": "application",
      "name": "project-name",
      "version": "0.0.0"
    }
  },
  "components": [
    {
      "type": "library",
      "name": "package-name",
      "version": "1.2.3",
      "purl": "pkg:pypi/package-name@1.2.3",
      "scope": "required"
    }
  ]
}
```

## purl Format

Package URLs follow the `pkg:type/namespace/name@version` pattern:

| Ecosystem | purl Example |
|-----------|-------------|
| Python | `pkg:pypi/requests@2.31.0` |
| npm | `pkg:npm/%40scope/package@1.0.0` |
| Maven | `pkg:maven/org.apache/commons-lang3@3.12.0` |
| Go | `pkg:golang/github.com/gin-gonic/gin@1.9.1` |
