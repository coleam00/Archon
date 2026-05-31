#!/usr/bin/env python3
"""
Registry-driven component usage audit with SysML contract validation.

Three-layer architecture:
  1. Registry (.kiro/registry/shared-registry.yaml) — pattern violations
  2. SysML (.kiro/specs/*/model.sysml) — contract violations (use relationships)
  3. This script — reads both, verifies code matches intent

Optimizations:
  - Single file read: each source file read once, all checks run against cached content
  - Import-aware consumer tracking: matches import statements, not arbitrary word occurrences
  - Incremental mode: --changed-only scans only git-changed files
"""
import glob
import os
import re
import subprocess
import sys
import yaml

ALL_EXTENSIONS = ('.tsx', '.ts', '.jsx', '.js', '.py', '.yml', '.yaml', '.graphql')
SKIP_DIRS = {'node_modules', '__pycache__', 'venv', '.git', 'dist', 'build'}

# ─── Registry Loading ─────────────────────────────────────

def load_registry(project_root):
    config_path = os.path.join(project_root, '.kiro', 'config', 'project.yaml')
    if not os.path.exists(config_path):
        return None
    with open(config_path) as f:
        config = yaml.safe_load(f)
    registry_path = (config.get('shared') or {}).get('registry-path')
    if not registry_path:
        return None
    full_path = os.path.join(project_root, registry_path)
    if not os.path.exists(full_path):
        return None
    with open(full_path) as f:
        return yaml.safe_load(f)


def _iter_entries(registry):
    for section in ('frontend', 'backend', 'shared', 'infrastructure'):
        data = registry.get(section, {})
        if not isinstance(data, dict):
            continue
        for entries in data.values():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict) and 'name' in entry:
                    yield entry


# ─── Token Reference Resolution ───────────────────────────

TOKEN_REF_RE = re.compile(r'\{([^}]+)\}')


def resolve_refs(registry, value, _depth=0):
    """Resolve all {path.to.value} references in a string value."""
    if not isinstance(value, str) or '{' not in value:
        return value
    if _depth > 10:
        return value  # circular reference — leave unresolved

    def _resolve(match):
        path = match.group(1).split('.')
        # Tier 1: project.* references
        if path[0] == 'project' and len(path) >= 2:
            result = registry.get('project', {}).get(path[1])
            if result is not None:
                return str(result)
        # Tier 2: layer.category.entry-name[.field]
        if len(path) >= 3:
            layer, category, entry_name = path[0], path[1], path[2]
            entries = registry.get(layer, {}).get(category, [])
            if isinstance(entries, list):
                for entry in entries:
                    if isinstance(entry, dict) and entry.get('name') == entry_name:
                        if len(path) > 3:
                            result = entry.get(path[3])
                            if result is not None:
                                return str(result)
                        else:
                            return entry.get('path', match.group(0))
        return match.group(0)  # unresolved

    resolved = TOKEN_REF_RE.sub(_resolve, value)
    # Recurse if new refs were introduced by resolution
    if resolved != value and TOKEN_REF_RE.search(resolved):
        return resolve_refs(registry, resolved, _depth + 1)
    return resolved


def validate_refs(registry):
    """Scan all string values in registry entries for unresolved {…} references."""
    broken = []
    for entry in _iter_entries(registry):
        for field in ('path', 'description', 'rationale'):
            val = entry.get(field, '')
            if not isinstance(val, str):
                continue
            resolved = resolve_refs(registry, val)
            remaining = TOKEN_REF_RE.findall(resolved)
            for ref in remaining:
                broken.append({
                    'entry': entry['name'], 'field': field,
                    'ref': f'{{{ref}}}', 'severity': 'error',
                })
        # Check replaces patterns
        for r in entry.get('replaces', []):
            pat = r.get('pattern', '')
            if isinstance(pat, str):
                resolved = resolve_refs(registry, pat)
                for ref in TOKEN_REF_RE.findall(resolved):
                    broken.append({
                        'entry': entry['name'], 'field': 'replaces.pattern',
                        'ref': f'{{{ref}}}', 'severity': 'error',
                    })
    return broken


# ─── Component Contract Matching ──────────────────────────

def match_contract(entry, keywords):
    """Check if an entry's contract covers a set of requirement keywords.
    Returns (covers: bool, matched_props: list, missing: list).
    """
    contract = entry.get('contract')
    if not contract:
        return False, [], []
    props = contract.get('props', [])
    prop_names = {p['name'].lower() for p in props if isinstance(p, dict)}
    variants = {v.lower() for v in contract.get('variants', [])}
    all_features = prop_names | variants
    kw_lower = {k.lower() for k in keywords}
    matched = kw_lower & all_features
    missing = kw_lower - all_features
    covers = len(matched) > 0 and len(missing) <= len(matched)
    return covers, sorted(matched), sorted(missing)


def validate_contracts_schema(registry):
    """Warn if contract.props have inconsistent structure."""
    warnings = []
    for entry in _iter_entries(registry):
        contract = entry.get('contract')
        if not contract:
            continue
        for prop in contract.get('props', []):
            if not isinstance(prop, dict):
                warnings.append(f"{entry['name']}: contract.props entry is not a dict")
                continue
            if 'name' not in prop:
                warnings.append(f"{entry['name']}: contract.props entry missing 'name'")
            if 'type' not in prop:
                warnings.append(f"{entry['name']}: contract.props entry missing 'type'")
    return warnings


# ─── File Collection ──────────────────────────────────────

def collect_files(project_root, changed_only=False):
    """Collect source files to scan. Returns dict of rel_path → content."""
    files = {}
    if changed_only:
        try:
            result = subprocess.run(
                ['git', 'diff', '--name-only', 'HEAD~1'],
                capture_output=True, text=True, cwd=project_root
            )
            changed = set(result.stdout.strip().split('\n')) if result.stdout.strip() else set()
        except Exception:
            changed = None  # fall back to full scan
    else:
        changed = None

    src_dirs = ['frontend/src', 'src', 'infrastructure', 'shared']
    for src_rel in src_dirs:
        src_dir = os.path.join(project_root, src_rel)
        if not os.path.exists(src_dir):
            continue
        for root, dirs, fnames in os.walk(src_dir):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fname in fnames:
                if not any(fname.endswith(ext) for ext in ALL_EXTENSIONS):
                    continue
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, project_root)
                if changed is not None and rel not in changed:
                    continue
                try:
                    with open(fpath, encoding='utf-8', errors='ignore') as f:
                        files[rel] = f.read()
                except OSError:
                    pass
    return files


# ─── Single-Pass Analysis ─────────────────────────────────

def analyze(files, registry):
    """Run all checks in a single pass over cached file contents."""
    rules = []
    for entry in _iter_entries(registry):
        for r in entry.get('replaces', []):
            rules.append({
                'component': entry['name'], 'path': entry.get('path', ''),
                'pattern': r['pattern'], 'exclude': r.get('exclude', []),
                'severity': r.get('severity', 'warning'),
            })

    export_map = {}
    for entry in _iter_entries(registry):
        for exp in entry.get('exports', []):
            export_map[exp] = entry

    # Import patterns for accurate consumer tracking
    ts_import_re = re.compile(r'(?:import\s+.*?from\s+|import\s*\{[^}]*\})')
    py_import_re = re.compile(r'(?:from\s+\S+\s+import\s+|import\s+)')

    violations = []
    consumers = {}

    for rel, content in files.items():
        lines = content.split('\n')

        # Pattern violations
        for rule in rules:
            if any(exc in rel for exc in rule['exclude']):
                continue
            for i, line in enumerate(lines, 1):
                if rule['pattern'] in line:
                    violations.append({
                        'file': rel, 'line': i,
                        'component': rule['component'], 'path': rule['path'],
                        'severity': rule['severity'], 'type': 'pattern',
                    })

        # Consumer tracking (import-aware)
        is_ts = rel.endswith(('.tsx', '.ts', '.jsx', '.js'))
        import_lines = ''
        if is_ts:
            import_lines = '\n'.join(l for l in lines if ts_import_re.search(l))
        elif rel.endswith('.py'):
            import_lines = '\n'.join(l for l in lines if py_import_re.search(l))

        for exp_name, entry in export_map.items():
            if entry.get('path', '') in rel or 'cardverse-ui' in rel:
                continue
            # Check imports first, fall back to full content for non-standard patterns
            if re.search(rf'\b{re.escape(exp_name)}\b', import_lines or content):
                consumers.setdefault(entry['name'], set()).add(rel)

    return violations, {k: sorted(v) for k, v in consumers.items()}


# ─── SysML Contract Validation ────────────────────────────

def parse_sysml_uses(project_root):
    """Parse use relationships with proper brace-depth tracking."""
    uses = []
    for sysml_path in glob.glob(os.path.join(project_root, '.kiro', 'specs', '*', 'model.sysml')):
        try:
            with open(sysml_path) as f:
                content = f.read()
        except OSError:
            continue

        # Track brace depth to correctly associate use with part def
        current_part = None
        depth = 0
        part_depth = 0
        for line in content.split('\n'):
            stripped = line.strip()
            # Detect part def
            m = re.match(r'part\s+def\s+(\w+)', stripped)
            if m and '{' in stripped:
                current_part = m.group(1)
                part_depth = depth
                depth += stripped.count('{') - stripped.count('}')
                continue

            depth += stripped.count('{') - stripped.count('}')

            if current_part and depth > part_depth:
                um = re.match(r'use\s+(\w+)\s*;', stripped)
                if um:
                    uses.append({'consumer': current_part, 'dependency': um.group(1)})

            if depth <= part_depth:
                current_part = None
    return uses


def validate_contracts(files, uses, registry):
    """Verify each SysML use relationship has a matching import."""
    name_to_path = {}
    for entry in _iter_entries(registry):
        name_to_path[entry['name']] = entry.get('path', '')
        for exp in entry.get('exports', []):
            name_to_path[exp] = entry.get('path', '')

    violations = []
    for use in uses:
        dep = use['dependency']
        consumer = use['consumer']
        consumer_path = name_to_path.get(consumer, '')
        if not consumer_path or dep not in name_to_path:
            continue
        for rel, content in files.items():
            if consumer_path in rel:
                if not re.search(rf'\b{re.escape(dep)}\b', content):
                    violations.append({
                        'file': rel, 'line': 0,
                        'component': f'{consumer} → {dep}',
                        'path': name_to_path.get(dep, ''),
                        'severity': 'error', 'type': 'contract',
                    })
                break
    return violations


# ─── Reporting ────────────────────────────────────────────

def detect_cycles(uses):
    """Detect circular dependencies in use relationships."""
    graph = {}
    for u in uses:
        graph.setdefault(u['consumer'], set()).add(u['dependency'])
    cycles = []
    visited = set()
    path = []

    def dfs(node):
        if node in path:
            cycle_start = path.index(node)
            cycles.append(path[cycle_start:] + [node])
            return
        if node in visited:
            return
        path.append(node)
        for dep in graph.get(node, []):
            dfs(dep)
        path.pop()
        visited.add(node)

    for node in graph:
        dfs(node)
    return cycles


def detect_unused(registry, consumers):
    """Find shared components with exports but zero consumers."""
    unused = []
    for entry in _iter_entries(registry):
        if entry.get('exports') and not consumers.get(entry['name']):
            unused.append(entry['name'])
    return unused


def detect_stale_paths(project_root, registry):
    """Find registry entries whose path doesn't resolve to an actual file."""
    stale = []
    frontend_src = registry.get('project', {}).get('frontend-src', 'frontend/src')
    backend_src = registry.get('project', {}).get('backend-src', 'src/handlers')
    for entry in _iter_entries(registry):
        path = entry.get('path', '')
        if not path or path.startswith('@'):
            continue  # skip package refs
        # Try direct, then under frontend/src, then under src/
        candidates = [
            os.path.join(project_root, path),
            os.path.join(project_root, frontend_src, path),
            os.path.join(project_root, frontend_src, path + '.ts'),
            os.path.join(project_root, frontend_src, path + '.tsx'),
            os.path.join(project_root, frontend_src, path + '.js'),
        ]
        if not any(os.path.exists(c) for c in candidates):
            stale.append({'name': entry['name'], 'path': path})
    return stale


def detect_uncovered_files(project_root, files, registry):
    """Find source files not covered by any registry entry."""
    covered_paths = set()
    for entry in _iter_entries(registry):
        p = entry.get('path', '')
        if p:
            covered_paths.add(p)
    uncovered = []
    for rel in files:
        if not any(cp in rel for cp in covered_paths):
            # Only flag utility/service files, not page components
            if '/utils/' in rel or '/services/' in rel or '/handlers/' in rel:
                uncovered.append(rel)
    return uncovered


def auto_register_new_exports(project_root, files, registry):
    """Detect new shared files that should be in the registry. Returns suggestions."""
    suggestions = []
    shared_dirs = ['frontend/src/utils/', 'frontend/src/types/', 'src/handlers/shared/']
    registered_paths = set()
    for e in _iter_entries(registry):
        p = e.get('path', '')
        if p:
            registered_paths.add(p)
            # Also add with common extensions
            for ext in ('.ts', '.tsx', '.js', '.jsx', '.py'):
                registered_paths.add(p + ext)
    for rel in files:
        if '__tests__/' in rel or '.test.' in rel or '.spec.' in rel:
            continue
        for sd in shared_dirs:
            if rel.startswith(sd):
                # Strip project root prefix and check
                basename = rel[len(sd):]
                path_without_ext = os.path.splitext(rel[len(sd.split('/')[0]) + 1:])[0]
                if not any(rp in rel or path_without_ext == rp for rp in registered_paths):
                    suggestions.append(rel)
    return suggestions


def print_report(violations, registry, consumers, uses, project_root, files):
    # Token reference validation
    broken_refs = validate_refs(registry)
    print('── Token References ───────────────────────')
    if not broken_refs:
        print('  ✅ All token references resolve')
    else:
        for br in broken_refs:
            print(f"  ❌ {br['entry']}.{br['field']}: unresolved {br['ref']}")

    # Contract schema validation
    contract_warnings = validate_contracts_schema(registry)
    if contract_warnings:
        print('\n── Contract Schema Warnings ───────────────')
        for w in contract_warnings:
            print(f'  ⚠️  {w}')

    pattern_v = [v for v in violations if v['type'] == 'pattern']
    contract_v = [v for v in violations if v['type'] == 'contract']
    errors = [v for v in pattern_v if v['severity'] == 'error']
    warnings = [v for v in pattern_v if v['severity'] == 'warning']

    print('── Pattern Violations (Registry) ──────────')
    if not pattern_v:
        print('  ✅ No pattern violations')
    else:
        # Build rationale lookup
        rationale_map = {}
        for entry in _iter_entries(registry):
            if entry.get('rationale'):
                rationale_map[entry['name']] = entry['rationale'].strip().split('\n')[0]
        for v in sorted(pattern_v, key=lambda x: (x['severity'] != 'error', x['file'])):
            icon = '❌' if v['severity'] == 'error' else '⚠️'
            print(f"  {icon} {v['file']}:{v['line']} — use {v['component']} from {v['path']}")
            if v['component'] in rationale_map:
                print(f"      ↳ {rationale_map[v['component']]}")

    print('\n── Contract Violations (SysML) ────────────')
    if not contract_v:
        print('  ✅ No contract violations')
    else:
        for v in contract_v:
            print(f"  ❌ {v['component']} — missing import from {v['path']}")

    # Circular dependencies
    cycles = detect_cycles(uses)
    print('\n── Circular Dependencies ──────────────────')
    if not cycles:
        print('  ✅ No circular dependencies')
    else:
        for c in cycles:
            print(f'  ❌ {" → ".join(c)}')

    # Unused shared code
    unused = detect_unused(registry, consumers)
    print('\n── Unused Shared Code ────────────────────')
    if not unused:
        print('  ✅ All shared code has consumers')
    else:
        for name in unused:
            print(f'  ⚠️  {name}: 0 consumers — consider removing')

    # Stale registry paths
    stale = detect_stale_paths(project_root, registry)
    print('\n── Stale Registry Paths ──────────────────')
    if not stale:
        print('  ✅ All registry paths resolve')
    else:
        for s in stale:
            print(f'  ❌ {s["name"]}: {s["path"]} not found')

    # Auto-register suggestions
    suggestions = auto_register_new_exports(project_root, files, registry)
    if suggestions:
        print('\n── Unregistered Shared Files (BLOCKING) ───')
        for s in suggestions[:10]:
            print(f'  ❌ {s} — must be added to registry')
        if len(suggestions) > 10:
            print(f'  ... and {len(suggestions) - 10} more')

    print('\n── Consumer Tracking ──────────────────────')
    for comp, cfiles in sorted(consumers.items()):
        print(f'  {comp}: {len(cfiles)} consumer(s)')
        for f in cfiles[:3]:
            print(f'    → {f}')
        if len(cfiles) > 3:
            print(f'    ... and {len(cfiles) - 3} more')

    print('\n── Migration Status ───────────────────────')
    for entry in _iter_entries(registry):
        status = entry.get('migration-status')
        if not status:
            continue
        icon = {'complete': '✅', 'bridged': '🔄', 'pending': '⏳'}.get(status, '❓')
        count = len(consumers.get(entry['name'], []))
        print(f'  {icon} {entry["name"]}: {status} ({count} consumers)')

    total_errors = len(errors) + len(contract_v) + len(cycles) + len(stale) + len(suggestions) + len(broken_refs)
    print(f'\n  Summary: {len(errors)} pattern error(s), {len(warnings)} warning(s), '
          f'{len(contract_v)} contract, {len(cycles)} circular, {len(stale)} stale, {len(suggestions)} unregistered')
    return total_errors


# ─── Registry Diff Engine ─────────────────────────────────

def diff_registry(before, after):
    """Compare two registry versions. Returns structured diff report."""
    report = {'added': [], 'removed': [], 'modified': [], 'regressions': []}
    if before is None:
        # First commit — all additions
        report['added'] = [e['name'] for e in _iter_entries(after)]
        return report

    before_entries = {e['name']: e for e in _iter_entries(before)}
    after_entries = {e['name']: e for e in _iter_entries(after)}

    for name in after_entries:
        if name not in before_entries:
            report['added'].append(name)

    for name in before_entries:
        if name not in after_entries:
            report['removed'].append(name)
            report['regressions'].append({'type': 'removed', 'entry': name})

    for name in before_entries:
        if name not in after_entries:
            continue
        b, a = before_entries[name], after_entries[name]
        changes = []
        # Removed exports
        b_exports = set(b.get('exports', []))
        a_exports = set(a.get('exports', []))
        removed_exports = b_exports - a_exports
        if removed_exports:
            changes.append(f"exports removed: {sorted(removed_exports)}")
            report['regressions'].append({'type': 'exports_removed', 'entry': name, 'exports': sorted(removed_exports)})
        # Path changes
        if b.get('path') != a.get('path'):
            changes.append(f"path: {b.get('path')} → {a.get('path')}")
        # Contract narrowing
        b_props = {p['name'] for p in (b.get('contract', {}) or {}).get('props', []) if isinstance(p, dict)}
        a_props = {p['name'] for p in (a.get('contract', {}) or {}).get('props', []) if isinstance(p, dict)}
        removed_props = b_props - a_props
        if removed_props:
            changes.append(f"contract props removed: {sorted(removed_props)}")
            report['regressions'].append({'type': 'contract_narrowed', 'entry': name, 'props': sorted(removed_props)})
        if changes:
            report['modified'].append({'name': name, 'changes': changes})

    return report


def load_baseline_registry(project_root):
    """Load the previous version of the registry from git."""
    config_path = os.path.join(project_root, '.kiro', 'config', 'project.yaml')
    if not os.path.exists(config_path):
        return None
    with open(config_path) as f:
        config = yaml.safe_load(f)
    registry_path = (config.get('shared') or {}).get('registry-path')
    if not registry_path:
        return None
    try:
        result = subprocess.run(
            ['git', 'show', f'HEAD~1:{registry_path}'],
            capture_output=True, text=True, cwd=project_root
        )
        if result.returncode == 0 and result.stdout.strip():
            return yaml.safe_load(result.stdout)
    except Exception:
        pass
    return None


def print_diff_report(report):
    """Print the diff report in human-readable format."""
    print('── Registry Diff ──────────────────────────')
    if report['added']:
        print(f"  ➕ Added: {', '.join(report['added'])}")
    if report['removed']:
        print(f"  ➖ Removed: {', '.join(report['removed'])}")
    if report['modified']:
        for m in report['modified']:
            print(f"  ✏️  {m['name']}: {'; '.join(m['changes'])}")
    if report['regressions']:
        print(f"\n  ❌ REGRESSIONS: {len(report['regressions'])}")
        for r in report['regressions']:
            if r['type'] == 'removed':
                print(f"     REMOVED: {r['entry']}")
            elif r['type'] == 'exports_removed':
                print(f"     EXPORTS REMOVED: {r['entry']} — {r['exports']}")
            elif r['type'] == 'contract_narrowed':
                print(f"     CONTRACT NARROWED: {r['entry']} — props removed: {r['props']}")
    elif not report['added'] and not report['removed'] and not report['modified']:
        print('  ✅ No changes detected')
    else:
        print('\n  ✅ No regressions — all changes are non-breaking')
    return len(report['regressions'])


def main():
    project_root = os.getcwd()
    changed_only = '--changed-only' in sys.argv
    diff_mode = '--diff' in sys.argv
    for arg in sys.argv[1:]:
        if arg not in ('--changed-only', '--diff'):
            project_root = arg

    registry = load_registry(project_root)
    if not registry:
        print('⚠️  No shared registry configured.')
        sys.exit(0)

    # Diff mode — compare current vs baseline and exit
    if diff_mode:
        baseline = load_baseline_registry(project_root)
        report = diff_registry(baseline, registry)
        regression_count = print_diff_report(report)
        sys.exit(1 if regression_count > 0 else 0)

    files = collect_files(project_root, changed_only)
    violations, consumers = analyze(files, registry)

    uses = parse_sysml_uses(project_root)
    contract_violations = validate_contracts(files, uses, registry)
    violations.extend(contract_violations)

    error_count = print_report(violations, registry, consumers, uses, project_root, files)
    sys.exit(1 if error_count > 0 else 0)


if __name__ == '__main__':
    main()
