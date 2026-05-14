#!/usr/bin/env python3
"""
Validate frontend GraphQL queries against the CloudFormation schema definition.

Extracts the GraphQL schema from a CloudFormation template, parses every
query/mutation in the frontend service file, and verifies that every field in
the selection set exists in the corresponding return type.

Exits non-zero if any field is undefined — blocking deployment.

Required env vars (set by audit-steering-compliance.py from project.yaml):
    GRAPHQL_CFN_TEMPLATE  — path to CloudFormation template with schema Definition
    GRAPHQL_SERVICE_FILE  — path to frontend file with GraphQL query strings

Usage:
    GRAPHQL_CFN_TEMPLATE=infrastructure/cloudformation/api.yml \\
    GRAPHQL_SERVICE_FILE=frontend/src/services/graphqlService.js \\
    python3 ~/.kiro/scripts/validate-graphql-schema.py
"""

import os
import re
import sys
from pathlib import Path


def extract_schema_from_cfn(cfn_path: Path) -> str:
    lines = cfn_path.read_text().splitlines()
    schema_lines: list[str] = []
    capturing = False
    for line in lines:
        if not capturing:
            if re.match(r"\s+Definition:\s*\|", line):
                capturing = True
            continue
        if line == "" or line.startswith("        "):
            schema_lines.append(line[8:] if line.startswith("        ") else "")
        else:
            break
    if not schema_lines:
        print("ERROR: Could not find GraphQL schema Definition in CloudFormation template")
        sys.exit(2)
    return "\n".join(schema_lines)


def parse_types(schema: str) -> dict[str, set[str]]:
    types: dict[str, set[str]] = {}
    for m in re.finditer(r"type\s+(\w+)[^{]*\{([^}]+)\}", schema):
        body = m.group(2)
        fields = set()
        for line in body.strip().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            field_match = re.match(r"(\w+)\s*[:(]", line)
            if field_match:
                fields.add(field_match.group(1))
        types[m.group(1)] = fields
    return types


def parse_queries_and_mutations(schema: str) -> dict[str, str]:
    ops: dict[str, str] = {}
    for m in re.finditer(r"type\s+(Query|Mutation)[^{]*\{([^}]+)\}", schema):
        for line in m.group(2).strip().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            op_match = re.match(r"(\w+)\s*(?:\([^)]*\))?\s*:\s*\[?(\w+)", line)
            if op_match:
                ops[op_match.group(1)] = op_match.group(2)
    return ops


def extract_frontend_operations(js_path: Path) -> list[dict]:
    text = js_path.read_text()
    operations = []
    for m in re.finditer(r"`\s*(query|mutation)\s+(\w+)[^`]*`", text, re.DOTALL):
        operations.append({"type": m.group(1), "name": m.group(2), "body": m.group(0)})
    return operations


def extract_selection_fields(body: str, operation_field: str) -> list[str]:
    """Extract only leaf fields (skip nested object fields like 'psa {')."""
    pattern = rf"{re.escape(operation_field)}\s*(?:\([^)]*\))?\s*\{{([^}}]+)\}}"
    m = re.search(pattern, body, re.DOTALL)
    if not m:
        return []
    fields = []
    lines = m.group(1).strip().splitlines()
    skip_depth = 0
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("..."):
            continue
        # Track nested braces to skip nested selection contents
        skip_depth += stripped.count("{") - stripped.count("}")
        if skip_depth > 0:
            continue
        if stripped.startswith("}"):
            continue
        field_match = re.match(r"(\w+)", stripped)
        if field_match:
            fields.append(field_match.group(1))
    return fields


def main() -> int:
    cfn_path = os.environ.get("GRAPHQL_CFN_TEMPLATE", "")
    svc_path = os.environ.get("GRAPHQL_SERVICE_FILE", "")

    if not cfn_path or not svc_path:
        print("ERROR: Set GRAPHQL_CFN_TEMPLATE and GRAPHQL_SERVICE_FILE env vars")
        print("  or configure graphql: section in .kiro/config/project.yaml")
        return 2

    cfn_template = Path(cfn_path)
    graphql_service = Path(svc_path)

    if not cfn_template.exists():
        print(f"ERROR: CloudFormation template not found: {cfn_template}")
        return 2
    if not graphql_service.exists():
        print(f"ERROR: GraphQL service file not found: {graphql_service}")
        return 2

    schema = extract_schema_from_cfn(cfn_template)
    types = parse_types(schema)
    ops = parse_queries_and_mutations(schema)
    frontend_ops = extract_frontend_operations(graphql_service)

    errors = []
    checked = 0

    for op in frontend_ops:
        for op_field, return_type in ops.items():
            if op_field in op["body"]:
                fields = extract_selection_fields(op["body"], op_field)
                if not fields:
                    continue
                type_fields = types.get(return_type, set())
                if not type_fields:
                    continue
                checked += 1
                for field in fields:
                    if field not in type_fields:
                        errors.append(
                            f"  ❌ {op['name']}: field '{field}' not in type '{return_type}' "
                            f"(available: {', '.join(sorted(type_fields))})"
                        )

    print(f"Schema validation: checked {checked} operations against {len(types)} types")

    if errors:
        print(f"\n{'='*60}")
        print(f"BLOCKED — {len(errors)} undefined field(s) found:")
        print(f"{'='*60}")
        for e in errors:
            print(e)
        print(f"\nFix: remove undefined fields from queries or add missing fields to the schema")
        return 1

    print("✅ All frontend GraphQL fields exist in schema")
    return 0


if __name__ == "__main__":
    sys.exit(main())
