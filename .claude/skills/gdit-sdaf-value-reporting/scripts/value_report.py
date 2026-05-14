# /// script
# requires-python = ">=3.12"
# ///
"""Value Reporting — Aggregate and report AI-assisted development value from tasks.md effort tables."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, date, timedelta, timezone
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

__version__ = "1.0.0"
FORMAT_VERSION = "1.0.0"
MINUTES_PER_DAY = 480  # 8h work day


# ---------------------------------------------------------------------------
# Data Model (Task 2 — REQ-1, REQ-2)
# ---------------------------------------------------------------------------

@dataclass
class TaskMetrics:
    task_number: int
    spec_name: str
    story_points_estimate: int | None = None
    story_points_actual: int | None = None
    traditional_human_loe_minutes: int | None = None
    ai_assisted_estimate_minutes: int | None = None
    ai_assisted_actual_minutes: int | None = None
    start: datetime | None = None
    complete: datetime | None = None

    @property
    def is_completed(self) -> bool:
        return self.complete is not None

    @property
    def is_in_progress(self) -> bool:
        return self.start is not None and self.complete is None

    @property
    def savings_minutes(self) -> int | None:
        if self.traditional_human_loe_minutes is not None and self.ai_assisted_actual_minutes is not None:
            return self.traditional_human_loe_minutes - self.ai_assisted_actual_minutes
        return None


@dataclass
class SpecMetrics:
    spec_name: str
    tasks: list[TaskMetrics] = field(default_factory=list)
    task_header_count: int = 0  # tasks detected by ### Task N: headers

    @property
    def completed_count(self) -> int:
        return sum(1 for t in self.tasks if t.is_completed)

    @property
    def in_progress_count(self) -> int:
        return sum(1 for t in self.tasks if t.is_in_progress)

    @property
    def not_started_count(self) -> int:
        return sum(1 for t in self.tasks if t.start is None)

    @property
    def missing_data_count(self) -> int:
        task_nums_with_data = {t.task_number for t in self.tasks}
        return max(0, self.task_header_count - len(task_nums_with_data))

    def _paired_savings(self) -> list[TaskMetrics]:
        return [t for t in self.tasks if t.traditional_human_loe_minutes is not None and t.ai_assisted_actual_minutes is not None]

    def sum_field(self, field_name: str) -> int | None:
        vals = [getattr(t, field_name) for t in self.tasks if getattr(t, field_name) is not None]
        return sum(vals) if vals else None

    @property
    def total_savings_minutes(self) -> int | None:
        paired = self._paired_savings()
        if not paired:
            return None
        return sum(t.traditional_human_loe_minutes - t.ai_assisted_actual_minutes for t in paired)

    @property
    def savings_percentage(self) -> float | None:
        paired = self._paired_savings()
        if not paired:
            return None
        human = sum(t.traditional_human_loe_minutes for t in paired)
        if human == 0:
            return None
        return (sum(t.traditional_human_loe_minutes - t.ai_assisted_actual_minutes for t in paired) / human) * 100

    @property
    def savings_ratio(self) -> float | None:
        paired = self._paired_savings()
        if not paired:
            return None
        human = sum(t.traditional_human_loe_minutes for t in paired)
        ai = sum(t.ai_assisted_actual_minutes for t in paired)
        if ai == 0:
            return None
        return human / ai


@dataclass
class ProjectMetrics:
    specs: list[SpecMetrics] = field(default_factory=list)
    specs_dir: str = ""
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def all_tasks(self) -> list[TaskMetrics]:
        return [t for s in self.specs for t in s.tasks]

    @property
    def task_count(self) -> int:
        return sum(len(s.tasks) for s in self.specs)

    @property
    def completed_count(self) -> int:
        return sum(s.completed_count for s in self.specs)

    @property
    def in_progress_count(self) -> int:
        return sum(s.in_progress_count for s in self.specs)

    @property
    def completion_rate(self) -> float | None:
        total = self.task_count
        if total == 0:
            return None
        return (self.completed_count / total) * 100

    def sum_field(self, field_name: str) -> int | None:
        vals = [v for s in self.specs if (v := s.sum_field(field_name)) is not None]
        return sum(vals) if vals else None

    def _paired_savings(self) -> list[TaskMetrics]:
        return [t for s in self.specs for t in s._paired_savings()]

    @property
    def total_savings_minutes(self) -> int | None:
        paired = self._paired_savings()
        if not paired:
            return None
        return sum(t.traditional_human_loe_minutes - t.ai_assisted_actual_minutes for t in paired)

    @property
    def savings_percentage(self) -> float | None:
        paired = self._paired_savings()
        if not paired:
            return None
        human = sum(t.traditional_human_loe_minutes for t in paired)
        if human == 0:
            return None
        return ((human - sum(t.ai_assisted_actual_minutes for t in paired)) / human) * 100

    @property
    def savings_ratio(self) -> float | None:
        paired = self._paired_savings()
        if not paired:
            return None
        human = sum(t.traditional_human_loe_minutes for t in paired)
        ai = sum(t.ai_assisted_actual_minutes for t in paired)
        if ai == 0:
            return None
        return human / ai

    @property
    def velocity_points_per_month(self) -> float | None:
        completed = [t for t in self.all_tasks if t.is_completed and t.story_points_actual is not None]
        if not completed:
            return None
        dates = [t.complete for t in completed]
        first, last = min(dates), max(dates)
        span = (last - first).total_seconds() / (30.44 * 86400)  # avg days/month
        if span < 0.1:
            span = 1.0
        return sum(t.story_points_actual for t in completed) / span


# ---------------------------------------------------------------------------
# Time Parsing (Task 1 — REQ-5)
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(
    r"(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?",
    re.IGNORECASE,
)


def parse_time(value: str) -> int | None:
    """Parse a time string like '30m', '1h', '1h 30m', '2d', '1d 4h' into minutes."""
    value = value.strip()
    if not value:
        return None
    m = _TIME_RE.fullmatch(value)
    if not m or not any(m.groups()):
        return None
    days = float(m.group(1) or 0)
    hours = float(m.group(2) or 0)
    minutes = float(m.group(3) or 0)
    total = days * MINUTES_PER_DAY + hours * 60 + minutes
    return int(round(total))


def format_time(minutes: int | None) -> str:
    """Format minutes back to human-readable string."""
    if minutes is None:
        return ""
    if minutes >= MINUTES_PER_DAY:
        d = minutes // MINUTES_PER_DAY
        rem = minutes % MINUTES_PER_DAY
        h = rem // 60
        m = rem % 60
        parts = [f"{d}d"]
        if h:
            parts.append(f"{h}h")
        if m:
            parts.append(f"{m}m")
        return " ".join(parts)
    if minutes >= 60:
        h = minutes // 60
        m = minutes % 60
        return f"{h}h {m}m" if m else f"{h}h"
    return f"{minutes}m"


def parse_timestamp(value: str) -> datetime | None:
    """Parse ISO 8601 timestamp, normalizing naive datetimes to UTC."""
    value = value.strip()
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def parse_int(value: str) -> int | None:
    """Parse an integer string, return None for empty/invalid."""
    value = value.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Spec Discovery and Parsing (Task 1 — REQ-1, REQ-5)
# ---------------------------------------------------------------------------

def discover_specs(specs_dir: str) -> list[tuple[str, Path]]:
    """Find all tasks.md files under specs_dir. Returns (spec_name, path) pairs."""
    specs_path = Path(specs_dir)
    results = []
    if not specs_path.is_dir():
        return results
    for tasks_file in sorted(specs_path.rglob("tasks.md")):
        parent = tasks_file.parent
        rel = parent.relative_to(specs_path)
        spec_name = str(rel).replace(os.sep, "/")
        results.append((spec_name, tasks_file))
    return results


def _count_task_headers(text: str) -> int:
    """Count ### Task N: or ## Task N: headers."""
    return len(re.findall(r"^#{2,3}\s+Task\s+\d+", text, re.MULTILINE))


def _parse_format_a(text: str, spec_name: str) -> list[TaskMetrics] | None:
    """Parse Format A: summary horizontal table."""
    lines = text.splitlines()
    header_idx = None
    for i, line in enumerate(lines):
        if "|" in line and "Story Points" in line:
            header_idx = i
            break
    if header_idx is None:
        return None

    # Parse header to find column positions
    header_cells = [c.strip() for c in lines[header_idx].split("|")]
    col_map: dict[str, int] = {}
    for idx, cell in enumerate(header_cells):
        cell_lower = cell.lower()
        if cell_lower == "task":
            col_map["task"] = idx
        elif "story points" in cell_lower and "estimate" in cell_lower:
            col_map["sp_est"] = idx
        elif "story points" in cell_lower and "actual" in cell_lower:
            col_map["sp_act"] = idx
        elif "traditional" in cell_lower or "human loe" in cell_lower:
            col_map["human_loe"] = idx
        elif "ai-assisted" in cell_lower and "estimate" in cell_lower:
            col_map["ai_est"] = idx
        elif "ai-assisted" in cell_lower and "actual" in cell_lower:
            col_map["ai_act"] = idx
        elif cell_lower == "start":
            col_map["start"] = idx
        elif cell_lower == "complete":
            col_map["complete"] = idx

    if "task" not in col_map:
        return None

    tasks = []
    for i in range(header_idx + 1, len(lines)):
        line = lines[i].strip()
        if not line or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        # Skip separator rows
        if all(c.replace("-", "").replace(":", "").strip() == "" for c in cells if c):
            continue
        task_num = parse_int(cells[col_map["task"]] if "task" in col_map and col_map["task"] < len(cells) else "")
        if task_num is None:
            continue

        def _cell(key: str) -> str:
            idx = col_map.get(key)
            if idx is None or idx >= len(cells):
                return ""
            return cells[idx].strip()

        tm = TaskMetrics(
            task_number=task_num,
            spec_name=spec_name,
            story_points_estimate=parse_int(_cell("sp_est")),
            story_points_actual=parse_int(_cell("sp_act")),
            traditional_human_loe_minutes=parse_time(_cell("human_loe")),
            ai_assisted_estimate_minutes=parse_time(_cell("ai_est")),
            ai_assisted_actual_minutes=parse_time(_cell("ai_act")),
            start=parse_timestamp(_cell("start")),
            complete=parse_timestamp(_cell("complete")),
        )
        # Warn on unparseable time values
        for field_name, raw in [("Traditional Human LOE", _cell("human_loe")),
                                 ("AI-Assisted Estimate", _cell("ai_est")),
                                 ("AI-Assisted Actual", _cell("ai_act"))]:
            if raw and parse_time(raw) is None:
                print(f"Warning: {spec_name} Task {task_num} — unparseable {field_name}: '{raw}'", file=sys.stderr)
        tasks.append(tm)
    return tasks if tasks else None


def _parse_format_b(text: str, spec_name: str) -> list[TaskMetrics] | None:
    """Parse Format B: per-task vertical metric tables."""
    tasks = []
    # Split by task headers
    task_sections = re.split(r"(?=^#{2,3}\s+Task\s+\d+)", text, flags=re.MULTILINE)
    for section in task_sections:
        header_match = re.match(r"^#{2,3}\s+Task\s+(\d+)", section)
        if not header_match:
            continue
        task_num = int(header_match.group(1))

        # Look for | Metric | Value | table
        metric_map: dict[str, str] = {}
        in_table = False
        for line in section.splitlines():
            stripped = line.strip()
            if "|" in stripped and "Metric" in stripped and "Value" in stripped:
                in_table = True
                continue
            if in_table and stripped.startswith("|"):
                cells = [c.strip() for c in stripped.split("|")]
                cells = [c for c in cells if c]
                if len(cells) >= 2 and not all(ch in "-:" for ch in cells[0]):
                    metric_map[cells[0].lower()] = cells[1] if len(cells) > 1 else ""
            elif in_table and not stripped.startswith("|"):
                in_table = False

        if not metric_map:
            continue

        def _get(key_fragment: str) -> str:
            for k, v in metric_map.items():
                if key_fragment in k:
                    return v
            return ""

        sp_est_raw = _get("story points") if "estimate" in "".join(k for k in metric_map if "story points" in k and "estimate" in k) else ""
        sp_act_raw = ""
        ai_est_raw = ""
        ai_act_raw = ""
        human_raw = ""
        start_raw = ""
        complete_raw = ""

        for k, v in metric_map.items():
            if "story points" in k and "estimate" in k:
                sp_est_raw = v
            elif "story points" in k and "actual" in k:
                sp_act_raw = v
            elif "traditional" in k or "human loe" in k:
                human_raw = v
            elif "ai-assisted" in k and "estimate" in k:
                ai_est_raw = v
            elif "ai-assisted" in k and "actual" in k:
                ai_act_raw = v
            elif k == "start":
                start_raw = v
            elif k == "complete":
                complete_raw = v

        tm = TaskMetrics(
            task_number=task_num,
            spec_name=spec_name,
            story_points_estimate=parse_int(sp_est_raw),
            story_points_actual=parse_int(sp_act_raw),
            traditional_human_loe_minutes=parse_time(human_raw),
            ai_assisted_estimate_minutes=parse_time(ai_est_raw),
            ai_assisted_actual_minutes=parse_time(ai_act_raw),
            start=parse_timestamp(start_raw),
            complete=parse_timestamp(complete_raw),
        )
        for field_name, raw in [("Traditional Human LOE", human_raw),
                                 ("AI-Assisted Estimate", ai_est_raw),
                                 ("AI-Assisted Actual", ai_act_raw)]:
            if raw and parse_time(raw) is None:
                print(f"Warning: {spec_name} Task {task_num} — unparseable {field_name}: '{raw}'", file=sys.stderr)
        tasks.append(tm)
    return tasks if tasks else None


def parse_tasks_md(spec_name: str, path: Path) -> SpecMetrics:
    """Parse a single tasks.md file into SpecMetrics."""
    text = path.read_text(encoding="utf-8")
    header_count = _count_task_headers(text)
    spec = SpecMetrics(spec_name=spec_name, task_header_count=header_count)

    # Try Format A first
    tasks = _parse_format_a(text, spec_name)
    if tasks is None:
        # Try Format B
        tasks = _parse_format_b(text, spec_name)
    if tasks:
        spec.tasks = tasks
    return spec


def load_project(specs_dir: str) -> ProjectMetrics:
    """Discover and parse all specs in a directory."""
    project = ProjectMetrics(specs_dir=specs_dir, generated_at=datetime.now(timezone.utc))
    discovered = discover_specs(specs_dir)
    if not discovered:
        return project
    for spec_name, path in discovered:
        spec = parse_tasks_md(spec_name, path)
        if not spec.tasks and spec.task_header_count == 0:
            print(f"Warning: {spec_name} — no effort tables found, skipping", file=sys.stderr)
        project.specs.append(spec)
    return project


# ---------------------------------------------------------------------------
# Report Data Builders
# ---------------------------------------------------------------------------

def _spec_to_dict(spec: SpecMetrics, detail: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "spec_name": spec.spec_name,
        "task_count": len(spec.tasks),
        "completed": spec.completed_count,
        "in_progress": spec.in_progress_count,
        "story_points_estimate": spec.sum_field("story_points_estimate"),
        "story_points_actual": spec.sum_field("story_points_actual"),
        "traditional_human_loe_minutes": spec.sum_field("traditional_human_loe_minutes"),
        "ai_assisted_actual_minutes": spec.sum_field("ai_assisted_actual_minutes"),
        "savings_minutes": spec.total_savings_minutes,
        "savings_percentage": _round(spec.savings_percentage),
        "savings_ratio": _round(spec.savings_ratio, 1),
    }
    if detail:
        d["tasks"] = [_task_to_dict(t) for t in spec.tasks]
    return d


def _task_to_dict(t: TaskMetrics) -> dict[str, Any]:
    flag = _estimation_flag(t)
    return {
        "task_number": t.task_number,
        "spec_name": t.spec_name,
        "story_points_estimate": t.story_points_estimate,
        "story_points_actual": t.story_points_actual,
        "traditional_human_loe_minutes": t.traditional_human_loe_minutes,
        "ai_assisted_estimate_minutes": t.ai_assisted_estimate_minutes,
        "ai_assisted_actual_minutes": t.ai_assisted_actual_minutes,
        "start": t.start.isoformat() if t.start else None,
        "complete": t.complete.isoformat() if t.complete else None,
        "savings_minutes": t.savings_minutes,
        "flag": flag,
    }


def _estimation_flag(t: TaskMetrics) -> str:
    if t.ai_assisted_estimate_minutes is None or t.ai_assisted_actual_minutes is None:
        return ""
    if t.ai_assisted_actual_minutes > 2 * t.ai_assisted_estimate_minutes:
        return "▲ UNDER"
    if t.ai_assisted_actual_minutes < 0.5 * t.ai_assisted_estimate_minutes:
        return "▼ OVER"
    return ""


def _round(val: float | None, decimals: int = 1) -> float | None:
    if val is None:
        return None
    return round(val, decimals)


def build_project_report(project: ProjectMetrics, detail: bool = False) -> dict[str, Any]:
    summary = {
        "spec_count": len([s for s in project.specs if s.tasks]),
        "task_count": project.task_count,
        "completed_count": project.completed_count,
        "in_progress_count": project.in_progress_count,
        "completion_rate": _round(project.completion_rate),
        "story_points_estimate": project.sum_field("story_points_estimate"),
        "story_points_actual": project.sum_field("story_points_actual"),
        "traditional_human_loe_minutes": project.sum_field("traditional_human_loe_minutes"),
        "ai_assisted_actual_minutes": project.sum_field("ai_assisted_actual_minutes"),
        "savings_minutes": project.total_savings_minutes,
        "savings_percentage": _round(project.savings_percentage),
        "savings_ratio": _round(project.savings_ratio, 1),
        "velocity_points_per_month": _round(project.velocity_points_per_month),
    }
    specs = [_spec_to_dict(s, detail) for s in project.specs if s.tasks]
    return {"summary": summary, "specs": specs}


def build_feature_report(project: ProjectMetrics, spec_filter: str | None, detail: bool) -> dict[str, Any]:
    specs = project.specs
    if spec_filter:
        use_glob = "*" in spec_filter or "?" in spec_filter
        if use_glob:
            specs = [s for s in specs if fnmatch(s.spec_name.lower(), spec_filter.lower())]
        else:
            specs = [s for s in specs if spec_filter.lower() in s.spec_name.lower()]
        detail = True  # --spec implies --detail
    return {"specs": [_spec_to_dict(s, detail) for s in specs if s.tasks]}


def build_trend_report(project: ProjectMetrics, period: str, since: date | None, until: date | None) -> dict[str, Any]:
    completed = [t for t in project.all_tasks if t.is_completed]
    excluded = len(project.all_tasks) - len(completed)

    # Apply date filters using local date
    def _local_date(dt: datetime) -> date:
        return dt.date()  # preserves local tz since we don't normalize to UTC

    if since:
        completed = [t for t in completed if _local_date(t.complete) >= since]
    if until:
        completed = [t for t in completed if _local_date(t.complete) <= until]

    # Bucket
    buckets: dict[str, list[TaskMetrics]] = {}
    for t in completed:
        ld = _local_date(t.complete)
        if period == "weekly":
            iso = ld.isocalendar()
            label = f"{iso.year}-W{iso.week:02d}"
        elif period == "quarterly":
            q = (ld.month - 1) // 3 + 1
            label = f"{ld.year}-Q{q}"
        else:
            label = f"{ld.year}-{ld.month:02d}"
        buckets.setdefault(label, []).append(t)

    periods_data = []
    for label in sorted(buckets):
        tasks = buckets[label]
        paired = [t for t in tasks if t.traditional_human_loe_minutes is not None and t.ai_assisted_actual_minutes is not None]
        human = sum(t.traditional_human_loe_minutes for t in paired) if paired else 0
        ai = sum(t.ai_assisted_actual_minutes for t in paired) if paired else 0
        points = sum(t.story_points_actual for t in tasks if t.story_points_actual is not None)
        savings = human - ai if paired else None
        periods_data.append({
            "period": label,
            "tasks": len(tasks),
            "points": points,
            "velocity": points,  # per-period
            "human_loe_minutes": human if paired else None,
            "ai_actual_minutes": ai if paired else None,
            "savings_minutes": savings,
            "savings_percentage": _round((savings / human * 100) if human and savings is not None else None),
            "savings_ratio": _round((human / ai) if ai else None, 1),
        })
    return {"periods": periods_data, "excluded_count": excluded}


def build_accuracy_report(project: ProjectMetrics) -> dict[str, Any]:
    spec_rows = []
    for s in project.specs:
        # Points: tasks with both estimate and actual
        pt_tasks = [t for t in s.tasks if t.story_points_estimate is not None and t.story_points_actual is not None and t.story_points_estimate > 0]
        # Time: tasks with both estimate and actual
        tm_tasks = [t for t in s.tasks if t.ai_assisted_estimate_minutes is not None and t.ai_assisted_actual_minutes is not None and t.ai_assisted_estimate_minutes > 0]
        if not pt_tasks and not tm_tasks:
            continue
        pt_est = sum(t.story_points_estimate for t in pt_tasks) if pt_tasks else None
        pt_act = sum(t.story_points_actual for t in pt_tasks) if pt_tasks else None
        pt_ratio = _round(pt_act / pt_est, 2) if pt_est else None
        tm_est = sum(t.ai_assisted_estimate_minutes for t in tm_tasks) if tm_tasks else None
        tm_act = sum(t.ai_assisted_actual_minutes for t in tm_tasks) if tm_tasks else None
        tm_ratio = _round(tm_act / tm_est, 2) if tm_est else None
        spec_rows.append({
            "spec_name": s.spec_name,
            "task_count": max(len(pt_tasks), len(tm_tasks)),
            "points_estimate": pt_est,
            "points_actual": pt_act,
            "points_ratio": pt_ratio,
            "time_estimate_minutes": tm_est,
            "time_actual_minutes": tm_act,
            "time_ratio": tm_ratio,
        })
    # Sort by worst time ratio deviation
    spec_rows.sort(key=lambda r: abs((r["time_ratio"] or 1.0) - 1.0), reverse=True)

    # Averages
    pt_ratios = [r["points_ratio"] for r in spec_rows if r["points_ratio"] is not None]
    tm_ratios = [r["time_ratio"] for r in spec_rows if r["time_ratio"] is not None]
    counts = [r["task_count"] for r in spec_rows]

    simple_pt = _round(sum(pt_ratios) / len(pt_ratios), 2) if pt_ratios else None
    simple_tm = _round(sum(tm_ratios) / len(tm_ratios), 2) if tm_ratios else None

    # Weighted averages
    weighted_pt = None
    if pt_ratios:
        w_sum = sum(r["points_ratio"] * r["task_count"] for r in spec_rows if r["points_ratio"] is not None)
        c_sum = sum(r["task_count"] for r in spec_rows if r["points_ratio"] is not None)
        weighted_pt = _round(w_sum / c_sum, 2) if c_sum else None
    weighted_tm = None
    if tm_ratios:
        w_sum = sum(r["time_ratio"] * r["task_count"] for r in spec_rows if r["time_ratio"] is not None)
        c_sum = sum(r["task_count"] for r in spec_rows if r["time_ratio"] is not None)
        weighted_tm = _round(w_sum / c_sum, 2) if c_sum else None

    return {
        "specs": spec_rows,
        "summary": {
            "simple_avg_points_ratio": simple_pt,
            "simple_avg_time_ratio": simple_tm,
            "weighted_avg_points_ratio": weighted_pt,
            "weighted_avg_time_ratio": weighted_tm,
        },
    }


def build_dashboard(project: ProjectMetrics) -> dict[str, Any]:
    acc = build_accuracy_report(project)
    return {
        "project": Path(project.specs_dir).parent.name if project.specs_dir else "unknown",
        "tasks_completed": project.completed_count,
        "tasks_in_progress": project.in_progress_count,
        "tasks_not_started": sum(s.not_started_count for s in project.specs),
        "savings_percentage": _round(project.savings_percentage),
        "savings_ratio": _round(project.savings_ratio, 1),
        "savings_minutes": project.total_savings_minutes,
        "velocity_points_per_month": _round(project.velocity_points_per_month),
        "estimation_accuracy_time": acc["summary"]["weighted_avg_time_ratio"],
    }


def build_status_report(project: ProjectMetrics) -> dict[str, Any]:
    specs = []
    for s in project.specs:
        specs.append({
            "spec_name": s.spec_name,
            "total": max(s.task_header_count, len(s.tasks)),
            "completed": s.completed_count,
            "in_progress": s.in_progress_count,
            "not_started": s.not_started_count,
            "missing_data": s.missing_data_count,
        })
    # Sort by most incomplete first
    specs.sort(key=lambda r: r["missing_data"] + r["not_started"], reverse=True)
    total = {k: sum(r[k] for r in specs) for k in ["total", "completed", "in_progress", "not_started", "missing_data"]}
    return {"specs": specs, "summary": total}


def build_value_summary_table(spec: SpecMetrics) -> str:
    """Generate the Value Summary markdown table for a spec."""
    lines = ["## Value Summary", "", "| Task | Points Est | Points Act | Human LOE | AI Est | AI Actual | Savings |",
             "|------|-----------|-----------|-----------|--------|-----------|---------|"]
    total_pt_est = total_pt_act = total_human = total_ai_est = total_ai_act = total_savings = 0
    has_any = False
    for t in spec.tasks:
        sav = t.savings_minutes
        lines.append(f"| {t.task_number} | {t.story_points_estimate or ''} | {t.story_points_actual or ''} | "
                     f"{format_time(t.traditional_human_loe_minutes)} | {format_time(t.ai_assisted_estimate_minutes)} | "
                     f"{format_time(t.ai_assisted_actual_minutes)} | {format_time(sav)} |")
        if t.story_points_estimate is not None:
            total_pt_est += t.story_points_estimate
        if t.story_points_actual is not None:
            total_pt_act += t.story_points_actual
        if t.traditional_human_loe_minutes is not None:
            total_human += t.traditional_human_loe_minutes
            has_any = True
        if t.ai_assisted_estimate_minutes is not None:
            total_ai_est += t.ai_assisted_estimate_minutes
        if t.ai_assisted_actual_minutes is not None:
            total_ai_act += t.ai_assisted_actual_minutes
        if sav is not None:
            total_savings += sav
    pct = f" ({total_savings * 100 // total_human}%)" if total_human else ""
    lines.append(f"| Total | {total_pt_est} | {total_pt_act} | {format_time(total_human)} | "
                 f"{format_time(total_ai_est)} | {format_time(total_ai_act)} | {format_time(total_savings)}{pct} |")
    return "\n".join(lines) + "\n"


def build_comparison(project: ProjectMetrics, range_a: tuple[date, date], range_b: tuple[date, date]) -> dict[str, Any]:
    def _metrics_for_range(tasks: list[TaskMetrics], start: date, end: date) -> dict[str, Any]:
        filtered = [t for t in tasks if t.is_completed and t.complete.date() >= start and t.complete.date() <= end]
        paired = [t for t in filtered if t.traditional_human_loe_minutes is not None and t.ai_assisted_actual_minutes is not None]
        human = sum(t.traditional_human_loe_minutes for t in paired) if paired else 0
        ai = sum(t.ai_assisted_actual_minutes for t in paired) if paired else 0
        savings = human - ai if paired else 0
        return {
            "tasks_completed": len(filtered),
            "points": sum(t.story_points_actual for t in filtered if t.story_points_actual is not None),
            "human_loe_minutes": human,
            "ai_actual_minutes": ai,
            "savings_minutes": savings,
            "savings_percentage": _round((savings / human * 100) if human else None),
            "savings_ratio": _round((human / ai) if ai else None, 1),
        }

    all_tasks = project.all_tasks
    a = _metrics_for_range(all_tasks, *range_a)
    b = _metrics_for_range(all_tasks, *range_b)

    delta = {}
    for key in a:
        va, vb = a[key], b[key]
        if va is None or vb is None:
            delta[key] = {"absolute": None, "change_pct": None, "direction": ""}
            continue
        abs_diff = vb - va
        pct = _round((abs_diff / va * 100) if va != 0 else None)
        # Direction: for savings/ratio higher is better; for ai_actual lower is better
        if key in ("ai_actual_minutes",):
            direction = "↑" if abs_diff < 0 else ("↓" if abs_diff > 0 else "")
        else:
            direction = "↑" if abs_diff > 0 else ("↓" if abs_diff < 0 else "")
        delta[key] = {"absolute": abs_diff, "change_pct": pct, "direction": direction}

    return {"period_a": a, "period_b": b, "delta": delta}


def build_cross_project(project_dirs: list[str]) -> dict[str, Any]:
    projects = []
    grand = ProjectMetrics()
    for d in project_dirs:
        specs_dir = str(Path(d) / ".kiro" / "specs")
        p = load_project(specs_dir)
        name = Path(d).name
        if not p.specs:
            print(f"Warning: {name} — no specs found in {specs_dir}", file=sys.stderr)
        report = build_project_report(p)
        report["project"] = name
        projects.append(report)
        grand.specs.extend(p.specs)

    grand_report = build_project_report(grand)
    return {"projects": projects, "grand_total": grand_report["summary"]}


# ---------------------------------------------------------------------------
# Output Formatters (Task 7 — REQ-4)
# ---------------------------------------------------------------------------

def _fmt_val(v: Any) -> str:
    if v is None:
        return "N/A"
    if isinstance(v, float):
        return f"{v:.1f}" if abs(v) >= 0.1 else f"{v:.2f}"
    return str(v)


def _fmt_time_val(minutes: int | None) -> str:
    if minutes is None:
        return "N/A"
    return format_time(minutes)


def _terminal_table(headers: list[str], rows: list[list[str]], title: str = "") -> str:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            if i < len(widths):
                widths[i] = max(widths[i], len(cell))
    sep = "─" + "─┼─".join("─" * w for w in widths) + "─"
    header_line = " " + " │ ".join(h.ljust(w) for h, w in zip(headers, widths)) + " "
    out = []
    if title:
        out.append(title)
        out.append("═" * len(sep))
    out.append(header_line)
    out.append(sep)
    for row in rows:
        cells = [(row[i] if i < len(row) else "").ljust(widths[i]) for i in range(len(headers))]
        out.append(" " + " │ ".join(cells) + " ")
    out.append("═" * len(sep))
    return "\n".join(out)


def _md_table(headers: list[str], rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(headers) + " |"]
    lines.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        cells = [row[i] if i < len(row) else "" for i in range(len(headers))]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _csv_output(headers: list[str], rows: list[list[str]], section: str = "") -> str:
    buf = io.StringIO()
    if section:
        buf.write(f"# {section}\n")
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)
    return buf.getvalue()


def _html_output(title: str, tables: list[tuple[str, list[str], list[list[str]]]], generated_at: str) -> str:
    html = [
        '<!DOCTYPE html>', '<html lang="en">', '<head>', '  <meta charset="UTF-8">',
        f'  <title>{title}</title>', '  <style>',
        '    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; }',
        '    h1 { color: #1a1a2e; } h2 { color: #16213e; }',
        '    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }',
        '    th { background: #16213e; color: #fff; padding: 0.5rem 1rem; text-align: left; }',
        '    td { padding: 0.5rem 1rem; border-bottom: 1px solid #e0e0e0; }',
        '    tr:nth-child(even) { background: #f5f5f5; }',
        '    tr.total { font-weight: bold; background: #e8f4f8; }',
        '    .meta { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }',
        '  </style>', '</head>', '<body>',
        f'  <h1>{title}</h1>',
        f'  <p class="meta">Generated: {generated_at}</p>',
    ]
    for subtitle, headers, rows in tables:
        if subtitle:
            html.append(f'  <h2>{subtitle}</h2>')
        html.append('  <table>')
        html.append('    <tr>' + ''.join(f'<th>{h}</th>' for h in headers) + '</tr>')
        for i, row in enumerate(rows):
            cls = ' class="total"' if i == len(rows) - 1 and any("Total" in c or "total" in c for c in row) else ""
            html.append(f'    <tr{cls}>' + ''.join(f'<td>{c}</td>' for c in row) + '</tr>')
        html.append('  </table>')
    html.extend(['</body>', '</html>'])
    return "\n".join(html)


# ---------------------------------------------------------------------------
# Format Dispatch
# ---------------------------------------------------------------------------

_SPEC_HEADERS = ["Spec", "Tasks", "Done", "In Prog", "Pts Est", "Pts Act", "Human LOE", "AI Actual", "Savings", "Savings %", "Ratio"]
_TASK_HEADERS = ["Task", "Pts Est", "Pts Act", "Human LOE", "AI Est", "AI Actual", "Savings", "Flag"]


def _spec_row(s: dict) -> list[str]:
    return [
        s["spec_name"], str(s["task_count"]), str(s["completed"]), str(s.get("in_progress", 0)),
        _fmt_val(s["story_points_estimate"]), _fmt_val(s["story_points_actual"]),
        _fmt_time_val(s["traditional_human_loe_minutes"]), _fmt_time_val(s["ai_assisted_actual_minutes"]),
        _fmt_time_val(s["savings_minutes"]), _fmt_val(s["savings_percentage"]) + "%" if s["savings_percentage"] is not None else "N/A",
        f'{s["savings_ratio"]}x' if s["savings_ratio"] is not None else "N/A",
    ]


def _task_row(t: dict) -> list[str]:
    return [
        str(t["task_number"]),
        _fmt_val(t["story_points_estimate"]), _fmt_val(t["story_points_actual"]),
        _fmt_time_val(t["traditional_human_loe_minutes"]),
        _fmt_time_val(t["ai_assisted_estimate_minutes"]),
        _fmt_time_val(t["ai_assisted_actual_minutes"]),
        _fmt_time_val(t["savings_minutes"]),
        t.get("flag", ""),
    ]


def format_report(data: dict[str, Any], scope: str, fmt: str, metadata: dict[str, Any]) -> str:
    if fmt == "json":
        return json.dumps({"metadata": metadata, "data": data}, indent=2, default=str)

    generated_at = metadata.get("generated_at", "")

    if scope == "dashboard":
        if fmt == "html":
            headers = ["Metric", "Value"]
            rows = [[k.replace("_", " ").title(), _fmt_val(v)] for k, v in data.items()]
            return _html_output(f"Value Dashboard — {data.get('project', '')}", [("", headers, rows)], generated_at)
        if fmt == "csv":
            return _csv_output(["metric", "value"], [[k, _fmt_val(v)] for k, v in data.items()], "Dashboard")
        if fmt == "markdown":
            lines = [f"## Value Dashboard — {data.get('project', '')}", ""]
            lines.append(_md_table(["Metric", "Value"], [[k.replace("_", " ").title(), _fmt_val(v)] for k, v in data.items()]))
            return "\n".join(lines)
        # terminal
        lines = [f"Value Dashboard — {data.get('project', '')}", "─" * 35]
        lines.append(f"Tasks: {data['tasks_completed']} completed, {data['tasks_in_progress']} in-progress, {data['tasks_not_started']} not started")
        sav_pct = _fmt_val(data['savings_percentage'])
        sav_ratio = _fmt_val(data['savings_ratio'])
        lines.append(f"Savings: {sav_pct}% ({sav_ratio}x) — {_fmt_time_val(data['savings_minutes'])} saved")
        lines.append(f"Velocity: {_fmt_val(data['velocity_points_per_month'])} points/month")
        lines.append(f"Estimation: {_fmt_val(data['estimation_accuracy_time'])} avg accuracy (time)")
        return "\n".join(lines)

    if scope == "status":
        headers = ["Spec", "Total", "Done", "In Prog", "Not Started", "Missing Data"]
        rows = [[r["spec_name"], str(r["total"]), str(r["completed"]), str(r["in_progress"]), str(r["not_started"]), str(r["missing_data"])] for r in data["specs"]]
        tot = data["summary"]
        rows.append(["Total", str(tot["total"]), str(tot["completed"]), str(tot["in_progress"]), str(tot["not_started"]), str(tot["missing_data"])])
        if fmt == "html":
            return _html_output("Task Status", [("", headers, rows)], generated_at)
        if fmt == "csv":
            return _csv_output(headers, rows, "Task Status")
        if fmt == "markdown":
            return "## Task Status\n\n" + _md_table(headers, rows)
        return _terminal_table(headers, rows, "Task Status")

    if scope == "trend":
        headers = ["Period", "Tasks", "Points", "Velocity", "Human LOE", "AI Actual", "Savings", "Savings %", "Ratio"]
        rows = []
        for p in data["periods"]:
            rows.append([p["period"], str(p["tasks"]), str(p["points"]), str(p["velocity"]),
                        _fmt_time_val(p["human_loe_minutes"]), _fmt_time_val(p["ai_actual_minutes"]),
                        _fmt_time_val(p["savings_minutes"]),
                        f'{p["savings_percentage"]}%' if p["savings_percentage"] is not None else "N/A",
                        f'{p["savings_ratio"]}x' if p["savings_ratio"] is not None else "N/A"])
        footer = f"\nNote: {data['excluded_count']} tasks excluded (missing Complete timestamp)" if data["excluded_count"] else ""
        if fmt == "html":
            return _html_output("Trend Analysis", [("", headers, rows)], generated_at) + (f"\n<!-- {footer.strip()} -->" if footer else "")
        if fmt == "csv":
            return _csv_output(headers, rows, "Trend Analysis") + footer
        if fmt == "markdown":
            return "## Trend Analysis\n\n" + _md_table(headers, rows) + ("\n\n" + footer.strip() if footer else "")
        return _terminal_table(headers, rows, "Trend Analysis") + footer

    if scope == "accuracy":
        headers = ["Spec", "Tasks", "Pts Est", "Pts Act", "Pts Ratio", "Time Est", "Time Act", "Time Ratio"]
        rows = []
        for r in data["specs"]:
            rows.append([r["spec_name"], str(r["task_count"]),
                        _fmt_val(r["points_estimate"]), _fmt_val(r["points_actual"]), _fmt_val(r["points_ratio"]),
                        _fmt_time_val(r["time_estimate_minutes"]), _fmt_time_val(r["time_actual_minutes"]), _fmt_val(r["time_ratio"])])
        s = data["summary"]
        summary_lines = f"\nSimple Avg  │ Pts: {_fmt_val(s['simple_avg_points_ratio'])}  │ Time: {_fmt_val(s['simple_avg_time_ratio'])}\nWeighted Avg│ Pts: {_fmt_val(s['weighted_avg_points_ratio'])}  │ Time: {_fmt_val(s['weighted_avg_time_ratio'])}"
        if fmt == "html":
            return _html_output("Estimation Accuracy", [("", headers, rows)], generated_at)
        if fmt == "csv":
            return _csv_output(headers, rows, "Estimation Accuracy")
        if fmt == "markdown":
            return "## Estimation Accuracy\n\n" + _md_table(headers, rows) + "\n\n" + summary_lines
        return _terminal_table(headers, rows, "Estimation Accuracy") + "\n" + summary_lines

    if scope == "comparison":
        headers = ["Metric", "Period A", "Period B", "Delta", "Change"]
        rows = []
        for key in data["period_a"]:
            va = data["period_a"][key]
            vb = data["period_b"][key]
            d = data["delta"][key]
            direction = d.get("direction", "") if isinstance(d, dict) else ""
            abs_d = d.get("absolute", "") if isinstance(d, dict) else ""
            pct = d.get("change_pct", "") if isinstance(d, dict) else ""
            pct_str = f"{pct}% {direction}" if pct is not None and pct != "" else f"N/A {direction}"
            rows.append([key.replace("_", " ").title(), _fmt_val(va), _fmt_val(vb), _fmt_val(abs_d), pct_str])
        if fmt == "html":
            return _html_output("Comparison", [("", headers, rows)], generated_at)
        if fmt == "csv":
            return _csv_output(headers, rows, "Comparison")
        if fmt == "markdown":
            return "## Comparison\n\n" + _md_table(headers, rows)
        return _terminal_table(headers, rows, "Comparison")

    # project or feature scope
    if "summary" in data:
        # Project scope
        s = data["summary"]
        summary_headers = ["Specs", "Tasks", "Done", "In Prog", "Pts Est", "Pts Act", "Human LOE", "AI Actual", "Savings", "Savings %", "Ratio"]
        summary_row = [str(s["spec_count"]), str(s["task_count"]), str(s["completed_count"]), str(s["in_progress_count"]),
                      _fmt_val(s["story_points_estimate"]), _fmt_val(s["story_points_actual"]),
                      _fmt_time_val(s["traditional_human_loe_minutes"]), _fmt_time_val(s["ai_assisted_actual_minutes"]),
                      _fmt_time_val(s["savings_minutes"]),
                      f'{s["savings_percentage"]}%' if s["savings_percentage"] is not None else "N/A",
                      f'{s["savings_ratio"]}x' if s["savings_ratio"] is not None else "N/A"]
        velocity_line = f"\nSavings: {_fmt_val(s['savings_percentage'])}%  │  Velocity: {_fmt_val(s['velocity_points_per_month'])} pts/month"
        spec_rows = [_spec_row(sp) for sp in data["specs"]]
        if fmt == "html":
            return _html_output("Value Report — Project Summary",
                               [("Summary", summary_headers, [summary_row]), ("Per Spec", _SPEC_HEADERS, spec_rows)], generated_at)
        if fmt == "csv":
            return _csv_output(summary_headers, [summary_row], "Project Summary") + "\n" + _csv_output(_SPEC_HEADERS, spec_rows, "Per-Spec Detail")
        if fmt == "markdown":
            return "## Project Summary\n\n" + _md_table(summary_headers, [summary_row]) + "\n\n## Per Spec\n\n" + _md_table(_SPEC_HEADERS, spec_rows)
        return _terminal_table(summary_headers, [summary_row], "Value Report — Project Summary") + velocity_line + "\n\n" + _terminal_table(_SPEC_HEADERS, spec_rows)

    # Feature scope
    spec_rows = []
    for sp in data["specs"]:
        spec_rows.append(_spec_row(sp))
        if "tasks" in sp:
            for t in sp["tasks"]:
                flag = t.get("flag", "")
                savings_str = _fmt_time_val(t["savings_minutes"])
                if flag:
                    savings_str = f"{savings_str} {flag}"
                spec_rows.append([
                    f"  Task {t['task_number']}", "", "", "",
                    _fmt_val(t["story_points_estimate"]), _fmt_val(t["story_points_actual"]),
                    _fmt_time_val(t["traditional_human_loe_minutes"]),
                    _fmt_time_val(t["ai_assisted_actual_minutes"]),
                    savings_str, "", "",
                ])
    if fmt == "html":
        return _html_output("Feature Detail", [("", _SPEC_HEADERS, spec_rows)], generated_at)
    if fmt == "csv":
        return _csv_output(_SPEC_HEADERS, spec_rows, "Feature Detail")
    if fmt == "markdown":
        return "## Feature Detail\n\n" + _md_table(_SPEC_HEADERS, spec_rows)
    return _terminal_table(_SPEC_HEADERS, spec_rows, "Feature Detail")


# ---------------------------------------------------------------------------
# CLI (Tasks 3-15)
# ---------------------------------------------------------------------------

def parse_date(s: str) -> date:
    return date.fromisoformat(s)


def parse_compare_arg(s: str) -> tuple[tuple[date, date], tuple[date, date]]:
    parts = s.split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("--compare requires two ranges: YYYY-MM-DD:YYYY-MM-DD,YYYY-MM-DD:YYYY-MM-DD")
    ranges = []
    for part in parts:
        dates = part.strip().split(":")
        if len(dates) != 2:
            raise argparse.ArgumentTypeError(f"Invalid range: {part}")
        ranges.append((parse_date(dates[0].strip()), parse_date(dates[1].strip())))
    return ranges[0], ranges[1]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="value_report",
        description="Aggregate and report AI-assisted development value from tasks.md effort tables.",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    p.add_argument("--scope", choices=["project", "feature"], default="project", help="Report scope (default: project)")
    p.add_argument("--format", choices=["terminal", "markdown", "csv", "json", "html"], default="terminal", dest="fmt", help="Output format (default: terminal)")
    p.add_argument("--spec", help="Filter to specs matching pattern (substring or glob)")
    p.add_argument("--detail", action="store_true", help="Show per-task breakdown")
    p.add_argument("--trend", action="store_true", help="Enable trend analysis")
    p.add_argument("--period", choices=["weekly", "monthly", "quarterly"], default="monthly", help="Trend period (default: monthly)")
    p.add_argument("--since", help="Include tasks completed on/after YYYY-MM-DD")
    p.add_argument("--until", help="Include tasks completed on/before YYYY-MM-DD")
    p.add_argument("--accuracy", action="store_true", help="Estimation accuracy report")
    p.add_argument("--update-summary", action="store_true", help="Generate/update Value Summary in tasks.md")
    p.add_argument("--projects", nargs="+", help="Cross-project mode: directory paths")
    p.add_argument("--compare", help="Compare two ranges: YYYY-MM-DD:YYYY-MM-DD,YYYY-MM-DD:YYYY-MM-DD")
    p.add_argument("--dashboard", action="store_true", help="Compact dashboard summary")
    p.add_argument("--status", action="store_true", help="Task completion status report")
    p.add_argument("--output", help="Write output to file instead of stdout")
    p.add_argument("--specs-dir", default=".kiro/specs/", help="Override specs directory (default: .kiro/specs/)")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code == 2 else (e.code or 0)

    # Mutual exclusion
    if args.projects and args.specs_dir != ".kiro/specs/":
        print("Error: --projects and --specs-dir are mutually exclusive", file=sys.stderr)
        return 2

    # Update summary requires --spec
    if args.update_summary and not args.spec:
        print("Error: --update-summary requires --spec to target a single spec", file=sys.stderr)
        return 2

    # Parse date filters
    since = parse_date(args.since) if args.since else None
    until = parse_date(args.until) if args.until else None

    # Parse compare ranges
    compare_ranges = None
    if args.compare:
        if args.projects and len(args.projects) == 2:
            compare_ranges = None  # project comparison mode
        else:
            try:
                compare_ranges = parse_compare_arg(args.compare)
            except (argparse.ArgumentTypeError, ValueError) as e:
                print(f"Error: {e}", file=sys.stderr)
                return 2

    # Load data
    if args.projects:
        if args.compare and len(args.projects) == 2:
            # Project comparison
            p1 = load_project(str(Path(args.projects[0]) / ".kiro" / "specs"))
            p2 = load_project(str(Path(args.projects[1]) / ".kiro" / "specs"))
            # Build comparison using full date range
            all_tasks_1 = p1.all_tasks
            all_tasks_2 = p2.all_tasks
            data = {
                "period_a": _project_summary_flat(p1, Path(args.projects[0]).name),
                "period_b": _project_summary_flat(p2, Path(args.projects[1]).name),
                "project_a": Path(args.projects[0]).name,
                "project_b": Path(args.projects[1]).name,
                "delta": {},
            }
            for key in data["period_a"]:
                va, vb = data["period_a"][key], data["period_b"][key]
                if va is None or vb is None or not isinstance(va, (int, float)):
                    data["delta"][key] = {"absolute": None, "change_pct": None, "direction": ""}
                    continue
                abs_diff = vb - va
                pct = _round((abs_diff / va * 100) if va != 0 else None)
                direction = "↑" if abs_diff > 0 else ("↓" if abs_diff < 0 else "")
                data["delta"][key] = {"absolute": abs_diff, "change_pct": pct, "direction": direction}
            scope = "comparison"
        else:
            data = build_cross_project(args.projects)
            scope = "project"
    else:
        project = load_project(args.specs_dir)
        if not project.specs or (not any(s.tasks for s in project.specs) and not args.status):
            if args.status and any(s.task_header_count > 0 for s in project.specs):
                pass  # status mode can work with header-only specs
            else:
                print("Warning: No effort data found", file=sys.stderr)
                return 1

        # Determine mode
        if args.update_summary:
            matching = [s for s in project.specs if s.spec_name == args.spec or args.spec.lower() in s.spec_name.lower()]
            if len(matching) != 1:
                use_glob = "*" in args.spec or "?" in args.spec
                if use_glob:
                    matching = [s for s in project.specs if fnmatch(s.spec_name.lower(), args.spec.lower())]
                if len(matching) != 1:
                    print(f"Error: --update-summary requires exactly one matching spec, found {len(matching)}", file=sys.stderr)
                    return 2
            spec = matching[0]
            summary_text = build_value_summary_table(spec)
            # Write to file
            tasks_path = Path(args.specs_dir) / spec.spec_name / "tasks.md"
            content = tasks_path.read_text(encoding="utf-8")
            marker = "## Value Summary"
            if marker in content:
                idx = content.index(marker)
                new_content = content[:idx] + summary_text
            else:
                new_content = content.rstrip() + "\n\n" + summary_text
            # Atomic write
            tmp_path = tasks_path.with_suffix(".tmp")
            tmp_path.write_text(new_content, encoding="utf-8")
            tmp_path.rename(tasks_path)
            print(summary_text)
            return 0

        if args.dashboard:
            data = build_dashboard(project)
            scope = "dashboard"
        elif args.status:
            data = build_status_report(project)
            scope = "status"
        elif args.trend:
            data = build_trend_report(project, args.period, since, until)
            scope = "trend"
        elif args.accuracy:
            data = build_accuracy_report(project)
            scope = "accuracy"
        elif args.compare:
            if compare_ranges is None:
                print("Error: invalid --compare format", file=sys.stderr)
                return 2
            data = build_comparison(project, *compare_ranges)
            scope = "comparison"
        elif args.scope == "feature" or args.spec:
            data = build_feature_report(project, args.spec, args.detail)
            scope = "feature"
        else:
            data = build_project_report(project, args.detail)
            scope = "project"

    metadata = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "specs_dir": args.specs_dir if not args.projects else str(args.projects),
        "scope": scope,
        "format_version": FORMAT_VERSION,
    }

    output = format_report(data, scope, args.fmt, metadata)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output, encoding="utf-8")
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(output)

    return 0


def _project_summary_flat(project: ProjectMetrics, name: str) -> dict[str, Any]:
    return {
        "tasks_completed": project.completed_count,
        "points": project.sum_field("story_points_actual"),
        "human_loe_minutes": project.sum_field("traditional_human_loe_minutes"),
        "ai_actual_minutes": project.sum_field("ai_assisted_actual_minutes"),
        "savings_minutes": project.total_savings_minutes,
        "savings_percentage": _round(project.savings_percentage),
        "savings_ratio": _round(project.savings_ratio, 1),
    }


if __name__ == "__main__":
    sys.exit(main())
