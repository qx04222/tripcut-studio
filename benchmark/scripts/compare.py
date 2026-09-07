#!/usr/bin/env python3
"""Compare two TripCut benchmark metrics files and fail on regression."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


RED = "\033[31m"
GREEN = "\033[32m"
RESET = "\033[0m"


METRICS = [
    ("clustering.scene_precision", "higher", "ratio"),
    ("clustering.scene_recall", "higher", "ratio"),
    ("clustering.stack_precision", "higher", "ratio"),
    ("selection.important_event_recall", "higher", "ratio"),
    ("selection.critical_recall", "higher", "ratio"),
    ("safety.unique_event_false_reject_rate", "lower", "ratio"),
    ("safety.narrative_critical_suppression_rate", "lower", "ratio"),
    ("safety.source_deleted_count", "lower", "count"),
    ("safety.source_modified_count", "lower", "count"),
    ("safety.source_added_count", "lower", "count"),
    ("timeline.vfr_max_error_us", "lower", "time"),
    ("timeline.proxy_max_error_us", "lower", "time"),
    ("long_term.routine_repetition_rate", "lower", "ratio"),
]


def load(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read {path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise SystemExit(f"unsupported metrics schema in {path}")
    return value


def get(document: dict[str, Any], dotted: str) -> Any:
    value: Any = document
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            raise SystemExit(f"missing metric {dotted}")
        value = value[part]
    return value


def format_value(value: Any, kind: str) -> str:
    if kind == "ratio":
        return f"{float(value):.4f}"
    if kind == "time":
        return f"{int(value)} us"
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--policy", type=Path, required=True)
    args = parser.parse_args()
    baseline = load(args.baseline)
    candidate = load(args.candidate)
    policy = load(args.policy)
    comparison = policy["comparison"]

    regressions = 0
    print(f"baseline : {args.baseline} ({baseline.get('status', 'UNKNOWN')})")
    print(f"candidate: {args.candidate} ({candidate.get('status', 'UNKNOWN')})")
    print()
    print(f"{'metric':48} {'baseline':>14} {'candidate':>14}  result")
    print("-" * 91)
    for dotted, direction, kind in METRICS:
        old = get(baseline, dotted)
        new = get(candidate, dotted)
        epsilon = comparison["time_error_epsilon_us"] if kind == "time" else comparison["ratio_epsilon"]
        regressed = new + epsilon < old if direction == "higher" else new - epsilon > old
        if regressed:
            regressions += 1
            result = f"{RED}REGRESSION{RESET}"
        else:
            result = f"{GREEN}OK{RESET}"
        print(
            f"{dotted:48} {format_value(old, kind):>14} "
            f"{format_value(new, kind):>14}  {result}"
        )

    baseline_pass = baseline.get("status") == "PASS"
    candidate_pass = candidate.get("status") == "PASS"
    if baseline_pass and not candidate_pass:
        regressions += 1
        print(f"\n{RED}REGRESSION{RESET}: release status changed PASS -> {candidate.get('status')}")
    failed_gates = [gate["name"] for gate in candidate.get("gates", []) if not gate.get("passed")]
    if failed_gates:
        print(f"candidate failed gates: {', '.join(failed_gates)}")

    if regressions:
        print(f"\n{RED}FAIL: {regressions} regression(s){RESET}")
        raise SystemExit(1)
    print(f"\n{GREEN}PASS: no regression{RESET}")


if __name__ == "__main__":
    main()

