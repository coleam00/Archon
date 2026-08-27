# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Resolve model-authored groups against authoritative assessor diagnoses."""

import json
import os


def string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def string_list(value: object, label: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ValueError(f"{label} must be an array of non-empty strings")
    if not allow_empty and not value:
        raise ValueError(f"{label} must not be empty")
    return value


def union(diagnoses: list[dict], field: str) -> list[str]:
    return list(dict.fromkeys(item for diagnosis in diagnoses for item in diagnosis[field]))


def main() -> int:
    assessments = json.loads(os.environ["INPUTS_ASSESSMENTS"])
    plan = json.loads(os.environ["INPUTS_ORDERS"])
    if not isinstance(assessments, list):
        raise ValueError("assessments must be the engine-owned fan-out array")
    if not isinstance(plan, dict) or not isinstance(plan.get("orders"), list):
        raise ValueError("work-orders output must contain an orders array")

    confirmed: dict[str, dict] = {}
    rejected: set[str] = set()
    for index, slot in enumerate(assessments):
        if isinstance(slot, dict) and slot.get("archon_failed") is True:
            raise ValueError(f"assessment slot {index} failed: {slot.get('error', 'unknown error')}")
        if not isinstance(slot, dict) or not isinstance(slot.get("assessment"), dict):
            raise ValueError(f"assessment slot {index} has no structured assessment")
        assessment = slot["assessment"]
        diagnosis_id = string(assessment.get("diagnosis_id"), f"assessment slot {index} diagnosis_id")
        if diagnosis_id in confirmed or diagnosis_id in rejected:
            raise ValueError(f"duplicate assessment diagnosis_id: {diagnosis_id}")
        if assessment.get("confirmed") is False:
            rejected.add(diagnosis_id)
            continue
        if assessment.get("confirmed") is not True:
            raise ValueError(f"assessment {diagnosis_id} has no boolean confirmed verdict")
        string(assessment.get("kind"), f"assessment {diagnosis_id} kind")
        string_list(assessment.get("owned_paths"), f"assessment {diagnosis_id} owned_paths")
        string_list(
            assessment.get("shared_primitives"),
            f"assessment {diagnosis_id} shared_primitives",
        )
        confirmed[diagnosis_id] = assessment

    prepared = []
    assigned: set[str] = set()
    concern_ids: set[str] = set()
    branches: set[str] = set()
    path_owners: dict[str, str] = {}
    primitive_owners: dict[str, str] = {}
    for index, raw_order in enumerate(plan["orders"]):
        if not isinstance(raw_order, dict):
            raise ValueError(f"order {index} must be an object")
        concern_id = string(raw_order.get("concern_id"), f"order {index} concern_id")
        title = string(raw_order.get("title"), f"order {concern_id} title")
        branch = string(raw_order.get("branch"), f"order {concern_id} branch")
        why_grouped = string(raw_order.get("why_grouped"), f"order {concern_id} why_grouped")
        diagnosis_ids = string_list(
            raw_order.get("diagnosis_ids"),
            f"order {concern_id} diagnosis_ids",
            allow_empty=False,
        )

        if concern_id in concern_ids:
            raise ValueError(f"duplicate concern_id: {concern_id}")
        concern_ids.add(concern_id)
        if branch in branches:
            raise ValueError(f"duplicate branch ownership: {branch}")
        branches.add(branch)

        selected = []
        for diagnosis_id in diagnosis_ids:
            if diagnosis_id in assigned:
                raise ValueError(f"duplicate diagnosis assignment: {diagnosis_id}")
            if diagnosis_id in rejected:
                raise ValueError(f"rejected diagnosis assigned to an order: {diagnosis_id}")
            if diagnosis_id not in confirmed:
                raise ValueError(f"unknown diagnosis assigned to an order: {diagnosis_id}")
            assigned.add(diagnosis_id)
            selected.append(confirmed[diagnosis_id])

        kinds = {diagnosis["kind"] for diagnosis in selected}
        if len(kinds) != 1:
            raise ValueError(f"order {concern_id} mixes diagnosis kinds: {sorted(kinds)}")
        owned_paths = union(selected, "owned_paths")
        shared_primitives = union(selected, "shared_primitives")
        for path in owned_paths:
            previous = path_owners.get(path)
            if previous is not None:
                raise ValueError(f"duplicate owned path ownership: {path} ({previous}, {concern_id})")
            path_owners[path] = concern_id
        for primitive in shared_primitives:
            previous = primitive_owners.get(primitive)
            if previous is not None:
                raise ValueError(
                    f"duplicate shared primitive ownership: {primitive} ({previous}, {concern_id})"
                )
            primitive_owners[primitive] = concern_id

        prepared.append({
            "concern_id": concern_id,
            "title": title,
            "branch": branch,
            "kind": next(iter(kinds)),
            "diagnosis_ids": diagnosis_ids,
            "owned_paths": owned_paths,
            "shared_primitives": shared_primitives,
            "why_grouped": why_grouped,
            "diagnoses": selected,
        })

    missing = sorted(set(confirmed) - assigned)
    if missing:
        raise ValueError(f"confirmed diagnoses missing from work orders: {missing}")

    print(json.dumps({"orders": prepared}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
