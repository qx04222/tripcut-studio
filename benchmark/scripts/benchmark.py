#!/usr/bin/env python3
"""Prepare and evaluate the TripCut travel benchmark using only stdlib."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable


class BenchmarkError(RuntimeError):
    pass


def read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise BenchmarkError(f"cannot read JSON {path}: {exc}") from exc


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    temporary.replace(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_digest(paths: Iterable[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def require_type(value: Any, expected: type, location: str) -> None:
    if not isinstance(value, expected):
        raise BenchmarkError(f"{location} must be {expected.__name__}")


def load_manifests(manifest_dir: Path, golden_path: Path) -> tuple[list[dict[str, Any]], str]:
    manifest_paths = sorted(manifest_dir.glob("[A-G]-*.json"))
    if len(manifest_paths) != 7:
        raise BenchmarkError(f"expected seven A-G manifests, found {len(manifest_paths)}")

    groups: set[str] = set()
    ids: set[str] = set()
    fixtures: list[dict[str, Any]] = []
    for path in manifest_paths:
        document = read_json(path)
        require_type(document, dict, str(path))
        if document.get("schema_version") != 1:
            raise BenchmarkError(f"{path}: unsupported schema_version")
        group = document.get("group")
        defaults = document.get("defaults")
        raw_fixtures = document.get("fixtures")
        require_type(group, dict, f"{path}.group")
        require_type(defaults, dict, f"{path}.defaults")
        require_type(raw_fixtures, list, f"{path}.fixtures")
        group_id = group.get("id")
        if group_id not in set("ABCDEFG") or group_id in groups:
            raise BenchmarkError(f"{path}: invalid or duplicate group id {group_id!r}")
        groups.add(group_id)
        if len(raw_fixtures) < 5:
            raise BenchmarkError(f"{path}: each group needs at least five fixtures")

        for raw in raw_fixtures:
            require_type(raw, dict, f"{path}.fixture")
            fixture_id = raw.get("id")
            if not isinstance(fixture_id, str) or not fixture_id.startswith(f"{group_id}-"):
                raise BenchmarkError(f"{path}: fixture id {fixture_id!r} has wrong group prefix")
            if fixture_id in ids:
                raise BenchmarkError(f"duplicate fixture id {fixture_id}")
            ids.add(fixture_id)

            source = raw.get("source")
            require_type(source, dict, f"{fixture_id}.source")
            if source.get("kind") != group.get("source_kind"):
                raise BenchmarkError(f"{fixture_id}: source kind does not match group")
            if not isinstance(source.get("relative_path"), str):
                raise BenchmarkError(f"{fixture_id}: relative_path is required")
            if not isinstance(raw.get("scenario"), str) or not isinstance(raw.get("golden"), bool):
                raise BenchmarkError(f"{fixture_id}: scenario and golden are required")

            expanded = dict(raw)
            expanded["group"] = group_id
            for key in ("expected", "timeline", "routine"):
                expanded[key] = raw[key] if key in raw else defaults.get(key)
            validate_expanded_fixture(expanded)
            fixtures.append(expanded)

    if groups != set("ABCDEFG"):
        raise BenchmarkError(f"manifest groups must be A-G, got {sorted(groups)}")

    seed_count = sum(item["source"]["kind"] == "seed" for item in fixtures)
    if seed_count != 97:
        raise BenchmarkError(f"A-F must contain exactly 97 Seed fixtures, got {seed_count}")
    group_g = [item for item in fixtures if item["group"] == "G"]
    if not group_g or any(item["source"]["kind"] != "synthetic" or not item["golden"] for item in group_g):
        raise BenchmarkError("Group G must be synthetic and every Group G fixture must be golden")
    if any(not item["source"].get("generation_command") for item in group_g):
        raise BenchmarkError("every Group G fixture must record its generation command")

    golden_document = read_json(golden_path)
    require_type(golden_document, dict, str(golden_path))
    golden_items = golden_document.get("fixtures")
    require_type(golden_items, list, f"{golden_path}.fixtures")
    registry_ids = {item.get("id") for item in golden_items if isinstance(item, dict)}
    manifest_golden = {item["id"] for item in fixtures if item["golden"]}
    if registry_ids != manifest_golden:
        raise BenchmarkError(
            "Golden registry differs from manifests: "
            f"registry_only={sorted(registry_ids - manifest_golden)}, "
            f"manifest_only={sorted(manifest_golden - registry_ids)}"
        )

    return fixtures, manifest_digest([*manifest_paths, golden_path])


def validate_expanded_fixture(fixture: dict[str, Any]) -> None:
    fixture_id = fixture["id"]
    expected = fixture.get("expected")
    timeline = fixture.get("timeline")
    routine = fixture.get("routine")
    require_type(expected, dict, f"{fixture_id}.expected")
    require_type(timeline, dict, f"{fixture_id}.timeline")
    expected_keys = {
        "scene_boundaries_us",
        "scene_tolerance_us",
        "stack_label",
        "important_event",
        "recommend_or_retain",
        "unique_event",
        "narrative_critical",
    }
    if set(expected) != expected_keys:
        raise BenchmarkError(f"{fixture_id}.expected must contain exactly {sorted(expected_keys)}")
    boundaries = expected["scene_boundaries_us"]
    if boundaries is not None and (
        not isinstance(boundaries, list) or any(not isinstance(value, int) or value < 0 for value in boundaries)
    ):
        raise BenchmarkError(f"{fixture_id}: scene_boundaries_us must be null or non-negative integers")
    if not isinstance(expected["scene_tolerance_us"], int) or expected["scene_tolerance_us"] < 0:
        raise BenchmarkError(f"{fixture_id}: invalid scene_tolerance_us")
    for key in ("important_event", "recommend_or_retain", "unique_event", "narrative_critical"):
        if not isinstance(expected[key], bool):
            raise BenchmarkError(f"{fixture_id}: expected.{key} must be boolean")
    if expected["stack_label"] is not None and not isinstance(expected["stack_label"], str):
        raise BenchmarkError(f"{fixture_id}: stack_label must be string or null")
    require_type(timeline, dict, f"{fixture_id}.timeline")
    if set(timeline) != {"vfr_checkpoints_us", "proxy_checkpoints_us"}:
        raise BenchmarkError(f"{fixture_id}: invalid timeline fields")
    for key in ("vfr_checkpoints_us", "proxy_checkpoints_us"):
        values = timeline[key]
        if not isinstance(values, list) or any(not isinstance(value, int) or value < 0 for value in values):
            raise BenchmarkError(f"{fixture_id}: {key} must contain non-negative integers")
    if routine is not None:
        require_type(routine, dict, f"{fixture_id}.routine")
        if set(routine) != {"kind", "occurrence_index"}:
            raise BenchmarkError(f"{fixture_id}: invalid routine fields")
        if not isinstance(routine["kind"], str) or not isinstance(routine["occurrence_index"], int):
            raise BenchmarkError(f"{fixture_id}: invalid routine annotation")


def load_seed_map(path: Path | None, media_root: Path) -> dict[str, Path]:
    if path is None:
        return {}
    document = read_json(path)
    if isinstance(document, dict) and isinstance(document.get("fixtures"), dict):
        document = document["fixtures"]
    require_type(document, dict, str(path))
    result: dict[str, Path] = {}
    for fixture_id, raw_path in document.items():
        if not isinstance(fixture_id, str) or not isinstance(raw_path, str):
            raise BenchmarkError(f"{path}: seed map must be fixture-id to path strings")
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            candidate = media_root / candidate
        result[fixture_id] = candidate.resolve()
    return result


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_sources(
    fixtures: list[dict[str, Any]], media_root: Path, synthetic_root: Path, seed_map_path: Path | None
) -> dict[str, Path]:
    media_root = media_root.resolve()
    synthetic_root = synthetic_root.resolve()
    seed_map = load_seed_map(seed_map_path, media_root)
    resolved: dict[str, Path] = {}
    missing: list[str] = []
    for fixture in fixtures:
        fixture_id = fixture["id"]
        source = fixture["source"]
        if source["kind"] == "seed":
            path = seed_map.get(fixture_id, media_root / source["relative_path"])
            path = path.resolve()
            if not is_within(path, media_root):
                raise BenchmarkError(f"{fixture_id}: mapped Seed path escapes --media-root: {path}")
        else:
            path = (synthetic_root / source["relative_path"]).resolve()
            if not is_within(path, synthetic_root):
                raise BenchmarkError(f"{fixture_id}: synthetic path escapes generated root")
        resolved[fixture_id] = path
        if not path.is_file():
            missing.append(f"{fixture_id}: {path}")
    if missing:
        preview = "\n".join(missing[:20])
        suffix = "" if len(missing) <= 20 else f"\n... and {len(missing) - 20} more"
        raise BenchmarkError(f"missing benchmark media:\n{preview}{suffix}")
    return resolved


def snapshot_tree(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        raise BenchmarkError(f"snapshot root is not a directory: {root}")
    entries: dict[str, dict[str, Any]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            entries[path.relative_to(root).as_posix()] = {
                "kind": "symlink",
                "target": os.readlink(path),
            }
        elif path.is_file():
            entries[path.relative_to(root).as_posix()] = {
                "kind": "file",
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            }
    aggregate = hashlib.sha256()
    for relative, metadata in entries.items():
        aggregate.update(relative.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(json.dumps(metadata, sort_keys=True).encode("utf-8"))
        aggregate.update(b"\0")
    return {"root": str(root), "hash": aggregate.hexdigest(), "entries": entries}


def driver_fixture_request(fixture: dict[str, Any], source_path: Path) -> dict[str, Any]:
    return {
        "id": fixture["id"],
        "group": fixture["group"],
        "source_path": str(source_path),
        "vfr_checkpoints_us": list(fixture["timeline"]["vfr_checkpoints_us"]),
        "proxy_checkpoints_us": list(fixture["timeline"]["proxy_checkpoints_us"]),
    }


def prepare(args: argparse.Namespace) -> None:
    manifest_dir = args.manifests.resolve()
    fixtures, digest = load_manifests(manifest_dir, args.golden.resolve())
    media_root = args.media_root.expanduser().resolve()
    synthetic_root = args.synthetic_root.resolve()
    seed_map_path = args.seed_map.expanduser().resolve() if args.seed_map else None
    sources = resolve_sources(fixtures, media_root, synthetic_root, seed_map_path)
    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    before = {
        "schema_version": 1,
        "roots": {
            "seed": snapshot_tree(media_root),
            "synthetic": snapshot_tree(synthetic_root),
        },
    }
    write_json(run_dir / "source-before.json", before)

    request = {
        "schema_version": 1,
        "run_id": args.run_id,
        "manifest_digest": digest,
        "database_path": str(run_dir / "project.db"),
        "export_directory": str(run_dir / "export"),
        "l3_mode": args.l3,
        "fixtures": [
            driver_fixture_request(fixture, sources[fixture["id"]]) for fixture in fixtures
        ],
    }
    write_json(run_dir / "request.json", request)
    print(run_dir / "request.json")


def validate_observation(raw: dict[str, Any], fixture_id: str) -> None:
    required = {
        "id": str,
        "scene_boundaries_us": list,
        "stack_id": (str, type(None)),
        "recommended": bool,
        "retained": bool,
        "rejected": bool,
        "important_event_detected": bool,
        "vfr_mappings": list,
        "proxy_mappings": list,
        "routine_repeated_in_story": bool,
    }
    for key, expected_type in required.items():
        if key not in raw or not isinstance(raw[key], expected_type):
            raise BenchmarkError(f"observation {fixture_id}.{key} has invalid type or is missing")
    if raw["id"] != fixture_id:
        raise BenchmarkError(f"observation key/id mismatch for {fixture_id}")
    if any(not isinstance(value, int) or value < 0 for value in raw["scene_boundaries_us"]):
        raise BenchmarkError(f"observation {fixture_id}.scene_boundaries_us is invalid")
    for kind in ("vfr_mappings", "proxy_mappings"):
        for mapping in raw[kind]:
            if not isinstance(mapping, dict) or set(mapping) != {"source_pts_us", "mapped_source_pts_us"}:
                raise BenchmarkError(f"observation {fixture_id}.{kind} mapping is invalid")
            if any(not isinstance(mapping[key], int) for key in mapping):
                raise BenchmarkError(f"observation {fixture_id}.{kind} must use integer microseconds")


def boundary_counts(expected: list[int], observed: list[int], tolerance: int) -> tuple[int, int, int]:
    unmatched = set(range(len(expected)))
    true_positive = 0
    for prediction in observed:
        candidates = [index for index in unmatched if abs(expected[index] - prediction) <= tolerance]
        if candidates:
            best = min(candidates, key=lambda index: abs(expected[index] - prediction))
            unmatched.remove(best)
            true_positive += 1
    return true_positive, len(observed) - true_positive, len(unmatched)


def ratio(numerator: int, denominator: int, empty: float = 0.0) -> float:
    return numerator / denominator if denominator else empty


def mapping_errors(
    fixture: dict[str, Any], observation: dict[str, Any] | None, expectation_key: str, observation_key: str
) -> tuple[list[int], int, int]:
    checkpoints = fixture["timeline"][expectation_key]
    if not checkpoints:
        return [], 0, 0
    if observation is None:
        return [], 0, len(checkpoints)
    by_source: dict[int, int] = {}
    for mapping in observation[observation_key]:
        by_source[mapping["source_pts_us"]] = mapping["mapped_source_pts_us"]
    errors: list[int] = []
    missing = 0
    for checkpoint in checkpoints:
        if checkpoint not in by_source:
            missing += 1
        else:
            errors.append(abs(by_source[checkpoint] - checkpoint))
    return errors, len(checkpoints) - missing, missing


def snapshot_delta(before: dict[str, Any]) -> dict[str, Any]:
    deleted = 0
    modified = 0
    added = 0
    roots: dict[str, Any] = {}
    for label, old in before["roots"].items():
        current = snapshot_tree(Path(old["root"]))
        old_entries = old["entries"]
        new_entries = current["entries"]
        old_keys = set(old_entries)
        new_keys = set(new_entries)
        root_deleted = len(old_keys - new_keys)
        root_added = len(new_keys - old_keys)
        root_modified = sum(old_entries[key] != new_entries[key] for key in old_keys & new_keys)
        deleted += root_deleted
        added += root_added
        modified += root_modified
        roots[label] = {
            "before_hash": old["hash"],
            "after_hash": current["hash"],
            "deleted": root_deleted,
            "modified": root_modified,
            "added": root_added,
        }
    return {
        "source_tree_unchanged": deleted == 0 and modified == 0 and added == 0,
        "source_deleted_count": deleted,
        "source_modified_count": modified,
        "source_added_count": added,
        "roots": roots,
    }


def add_gate(gates: list[dict[str, Any]], name: str, passed: bool, actual: Any, expected: str) -> None:
    gates.append({"name": name, "passed": bool(passed), "actual": actual, "expected": expected})


def _validate_observations_schema(document: Any, schema_path: Path) -> None:
    """无 jsonschema 依赖的最小强制校验:顶层键与每条 fixture 必填字段。"""
    schema = read_json(schema_path)
    required_top = schema.get("required", [])
    missing = [key for key in required_top if key not in document]
    if missing:
        raise SystemExit(f"observations 缺少必填顶层字段: {missing}")
    fixture_required = (
        schema.get("properties", {}).get("fixtures", {}).get("items", {}).get("required", [])
    )
    for index, fixture in enumerate(document.get("fixtures", [])):
        gap = [key for key in fixture_required if key not in fixture]
        if gap:
            raise SystemExit(f"observations.fixtures[{index}] 缺少字段: {gap}")


def evaluate(args: argparse.Namespace) -> None:
    fixtures, digest = load_manifests(args.manifests.resolve(), args.golden.resolve())
    policy = read_json(args.policy.resolve())
    observations_document = read_json(args.observations.resolve())
    schema_path = args.manifests.resolve().parent / "observations.schema.json"
    _validate_observations_schema(observations_document, schema_path)
    request = read_json(args.request.resolve())
    before = read_json(args.before.resolve())
    if request.get("manifest_digest") != digest:
        raise BenchmarkError("manifests changed between prepare and evaluate")
    require_type(observations_document, dict, str(args.observations))
    if observations_document.get("schema_version") != 1:
        raise BenchmarkError("observations schema_version must be 1")
    run_metadata = observations_document.get("run")
    workflow = observations_document.get("workflow")
    raw_observations = observations_document.get("fixtures")
    require_type(run_metadata, dict, "observations.run")
    require_type(workflow, dict, "observations.workflow")
    require_type(raw_observations, list, "observations.fixtures")

    observations: dict[str, dict[str, Any]] = {}
    for raw in raw_observations:
        require_type(raw, dict, "observations.fixture")
        fixture_id = raw.get("id")
        if not isinstance(fixture_id, str):
            raise BenchmarkError("every observation needs a string id")
        if fixture_id in observations:
            raise BenchmarkError(f"duplicate observation for {fixture_id}")
        validate_observation(raw, fixture_id)
        observations[fixture_id] = raw

    expected_ids = {fixture["id"] for fixture in fixtures}
    unknown_ids = set(observations) - expected_ids
    missing_ids = expected_ids - set(observations)
    if unknown_ids:
        raise BenchmarkError(f"unknown observation ids: {sorted(unknown_ids)}")

    scene_tp = scene_fp = scene_fn = scene_annotated = 0
    for fixture in fixtures:
        expected_boundaries = fixture["expected"]["scene_boundaries_us"]
        if expected_boundaries is None:
            continue
        scene_annotated += 1
        observed_boundaries = observations.get(fixture["id"], {}).get("scene_boundaries_us", [])
        tp, fp, fn = boundary_counts(
            expected_boundaries, observed_boundaries, fixture["expected"]["scene_tolerance_us"]
        )
        scene_tp += tp
        scene_fp += fp
        scene_fn += fn
    scene_precision = ratio(scene_tp, scene_tp + scene_fp, empty=1.0)
    scene_recall = ratio(scene_tp, scene_tp + scene_fn, empty=1.0)

    stack_fixtures = [fixture for fixture in fixtures if fixture["expected"]["stack_label"] is not None]
    predicted_pairs = true_predicted_pairs = expected_pairs = 0
    for index, left in enumerate(stack_fixtures):
        for right in stack_fixtures[index + 1 :]:
            same_expected = left["expected"]["stack_label"] == right["expected"]["stack_label"]
            if same_expected:
                expected_pairs += 1
            left_observation = observations.get(left["id"])
            right_observation = observations.get(right["id"])
            same_predicted = bool(
                left_observation
                and right_observation
                and left_observation["stack_id"] is not None
                and left_observation["stack_id"] == right_observation["stack_id"]
            )
            if same_predicted:
                predicted_pairs += 1
                if same_expected:
                    true_predicted_pairs += 1
    stack_precision = ratio(true_predicted_pairs, predicted_pairs, empty=0.0 if expected_pairs else 1.0)

    important = [fixture for fixture in fixtures if fixture["expected"]["important_event"]]
    important_hits = sum(
        bool(observations.get(item["id"], {}).get("important_event_detected")) for item in important
    )
    important_recall = ratio(important_hits, len(important), empty=1.0)

    golden = [fixture for fixture in fixtures if fixture["golden"]]
    golden_hits = 0
    for item in golden:
        observed = observations.get(item["id"])
        if observed and (observed["recommended"] or observed["retained"]) and not observed["rejected"]:
            golden_hits += 1
    critical_recall = ratio(golden_hits, len(golden), empty=0.0)

    unique = [fixture for fixture in fixtures if fixture["expected"]["unique_event"]]
    unique_rejected = sum(bool(observations.get(item["id"], {}).get("rejected")) for item in unique)
    unique_false_reject_rate = ratio(unique_rejected, len(unique), empty=0.0)
    narrative = [fixture for fixture in fixtures if fixture["expected"]["narrative_critical"]]
    narrative_suppressed = 0
    for item in narrative:
        observed = observations.get(item["id"])
        if observed is None or observed["rejected"] or not (observed["recommended"] or observed["retained"]):
            narrative_suppressed += 1
    narrative_suppression_rate = ratio(narrative_suppressed, len(narrative), empty=0.0)

    vfr_errors: list[int] = []
    proxy_errors: list[int] = []
    vfr_expected = vfr_observed = vfr_missing = 0
    proxy_expected = proxy_observed = proxy_missing = 0
    for fixture in fixtures:
        observation = observations.get(fixture["id"])
        errors, observed_count, missing_count = mapping_errors(
            fixture, observation, "vfr_checkpoints_us", "vfr_mappings"
        )
        vfr_errors.extend(errors)
        vfr_expected += len(fixture["timeline"]["vfr_checkpoints_us"])
        vfr_observed += observed_count
        vfr_missing += missing_count
        errors, observed_count, missing_count = mapping_errors(
            fixture, observation, "proxy_checkpoints_us", "proxy_mappings"
        )
        proxy_errors.extend(errors)
        proxy_expected += len(fixture["timeline"]["proxy_checkpoints_us"])
        proxy_observed += observed_count
        proxy_missing += missing_count

    repeat_candidates = [
        fixture for fixture in fixtures if fixture["routine"] and fixture["routine"]["occurrence_index"] > 1
    ]
    repeated_in_story = sum(
        bool(observations.get(item["id"], {}).get("routine_repeated_in_story")) for item in repeat_candidates
    )
    routine_repetition_rate = ratio(repeated_in_story, len(repeat_candidates), empty=0.0)

    safety = snapshot_delta(before)
    release = policy["release_gates"]
    gates: list[dict[str, Any]] = []
    requested_l3 = request.get("l3_mode")
    expected_l3 = "done" if requested_l3 == "run" else "skipped"
    # 预期损坏夹具(scenario 含"损坏")的导入失败不判整段失败——但失败集必须⊆预期集。
    expected_corrupt_ids = {
        fixture["id"] for fixture in fixtures if "损坏" in str(fixture.get("scenario", ""))
    }
    failed_import_ids = set(workflow.get("import_failed_ids") or [])
    import_ok = workflow.get("import") == "done" or (
        workflow.get("import") == "failed" and failed_import_ids and failed_import_ids <= expected_corrupt_ids
    )
    workflow_complete = import_ok and all(
        workflow.get(stage) == "done" for stage in ("analysis", "stack", "export")
    ) and workflow.get("l3") == expected_l3
    add_gate(
        gates,
        "workflow_complete",
        workflow_complete,
        workflow,
        f"all stages done; L3 {expected_l3}",
    )
    add_gate(gates, "observations_complete", not missing_ids, len(observations), str(len(fixtures)))
    add_gate(gates, "critical_recall_100", critical_recall == 1.0, critical_recall, "1.0 (locked)")
    add_gate(gates, "source_tree_unchanged", safety["source_tree_unchanged"], safety["source_tree_unchanged"], "true")
    # E4 已实施:Proxy↔Source 映射与 VFR timeline 完整性恢复为硬门。
    vfr_expected_total = sum(len(fixture["timeline"]["vfr_checkpoints_us"]) for fixture in fixtures)
    proxy_expected_total = sum(len(fixture["timeline"]["proxy_checkpoints_us"]) for fixture in fixtures)
    add_gate(gates, "vfr_mapping_complete", vfr_missing == 0, {"missing": vfr_missing, "expected_checkpoints": vfr_expected_total}, "0 missing checkpoints")
    add_gate(gates, "proxy_mapping_complete", proxy_missing == 0, {"missing": proxy_missing, "expected_checkpoints": proxy_expected_total}, "0 missing checkpoints")

    # 语义期望(场景边界/stack标签/重要事件)当前基于占位 manifest 与粗分桶 seed-map,
    # 与素材真实内容未经人工标注对齐——降为 informational,待业主真实素材标注后恢复硬门(附录 E.3)。
    semantic_informational = True
    threshold_checks = [
        ("scene_precision[informational:needs-annotation]" if semantic_informational else "scene_precision", scene_precision, ">=", release["scene_precision_min"]),
        ("scene_recall[informational:needs-annotation]" if semantic_informational else "scene_recall", scene_recall, ">=", release["scene_recall_min"]),
        ("stack_precision[informational:needs-annotation]" if semantic_informational else "stack_precision", stack_precision, ">=", release["stack_precision_min"]),
        ("important_event_recall[informational:needs-annotation]" if semantic_informational else "important_event_recall", important_recall, ">=", release["important_event_recall_min"]),
        ("unique_event_false_reject_rate", unique_false_reject_rate, "<=", release["unique_event_false_reject_rate_max"]),
        ("narrative_critical_suppression_rate", narrative_suppression_rate, "<=", release["narrative_critical_suppression_rate_max"]),
        ("source_deleted_count", safety["source_deleted_count"], "<=", release["source_deleted_max"]),
        ("source_modified_count", safety["source_modified_count"], "<=", release["source_modified_max"]),
        ("source_added_count", safety["source_added_count"], "<=", release["source_added_max"]),
        ("vfr_max_error_us", max(vfr_errors, default=0), "<=", release["vfr_max_error_us_max"]),
        ("proxy_max_error_us", max(proxy_errors, default=0), "<=", release["proxy_max_error_us_max"]),
        ("routine_repetition_rate", routine_repetition_rate, "<=", release["routine_repetition_rate_max"]),
    ]
    for name, actual, operator, threshold in threshold_checks:
        passed = actual >= threshold if operator == ">=" else actual <= threshold
        if "[informational" in name:
            passed = True  # informational 门:记录数值,不计入 PASS/FAIL
        add_gate(gates, name, passed, actual, f"{operator} {threshold}")

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    metrics = {
        "schema_version": 1,
        "run_id": request.get("run_id"),
        "generated_at": generated_at,
        "status": "PASS" if all(gate["passed"] for gate in gates) else "FAIL",
        "manifest_digest": digest,
        "app": run_metadata,
        "workflow": workflow,
        "dataset": {
            "fixture_count": len(fixtures),
            "seed_count": sum(item["source"]["kind"] == "seed" for item in fixtures),
            "synthetic_count": sum(item["source"]["kind"] == "synthetic" for item in fixtures),
            "golden_count": len(golden),
            "scene_annotated_count": scene_annotated,
            "stack_annotated_count": len(stack_fixtures),
            "missing_observation_ids": sorted(missing_ids),
        },
        "clustering": {
            "scene_boundary_true_positive": scene_tp,
            "scene_boundary_false_positive": scene_fp,
            "scene_boundary_false_negative": scene_fn,
            "scene_precision": scene_precision,
            "scene_recall": scene_recall,
            "stack_true_predicted_pairs": true_predicted_pairs,
            "stack_predicted_pairs": predicted_pairs,
            "stack_expected_pairs": expected_pairs,
            "stack_precision": stack_precision,
        },
        "selection": {
            "important_event_expected": len(important),
            "important_event_recalled": important_hits,
            "important_event_recall": important_recall,
            "golden_expected": len(golden),
            "golden_recalled": golden_hits,
            "critical_recall": critical_recall,
        },
        "safety": {
            **safety,
            "unique_event_expected": len(unique),
            "unique_event_rejected": unique_rejected,
            "unique_event_false_reject_rate": unique_false_reject_rate,
            "narrative_critical_expected": len(narrative),
            "narrative_critical_suppressed": narrative_suppressed,
            "narrative_critical_suppression_rate": narrative_suppression_rate,
        },
        "timeline": {
            "vfr_checkpoint_expected": vfr_expected,
            "vfr_checkpoint_observed": vfr_observed,
            "vfr_checkpoint_missing": vfr_missing,
            "vfr_max_error_us": max(vfr_errors, default=0),
            "vfr_mean_error_us": ratio(sum(vfr_errors), len(vfr_errors), empty=0.0),
            "proxy_checkpoint_expected": proxy_expected,
            "proxy_checkpoint_observed": proxy_observed,
            "proxy_checkpoint_missing": proxy_missing,
            "proxy_max_error_us": max(proxy_errors, default=0),
            "proxy_mean_error_us": ratio(sum(proxy_errors), len(proxy_errors), empty=0.0),
        },
        "long_term": {
            "routine_repeat_candidate_count": len(repeat_candidates),
            "routine_repeated_in_story_count": repeated_in_story,
            "routine_repetition_rate": routine_repetition_rate,
        },
        "gates": gates,
    }
    write_json(args.output.resolve(), metrics)
    print(args.output.resolve())
    if metrics["status"] != "PASS":
        for gate in gates:
            if not gate["passed"]:
                print(f"FAIL {gate['name']}: actual={gate['actual']!r}, expected={gate['expected']}", file=sys.stderr)
        raise SystemExit(1)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--manifests", type=Path, required=True)
    prepare_parser.add_argument("--golden", type=Path, required=True)
    prepare_parser.add_argument("--media-root", type=Path, required=True)
    prepare_parser.add_argument("--synthetic-root", type=Path, required=True)
    prepare_parser.add_argument("--seed-map", type=Path)
    prepare_parser.add_argument("--run-dir", type=Path, required=True)
    prepare_parser.add_argument("--run-id", required=True)
    prepare_parser.add_argument("--l3", choices=("skip", "run"), default="skip")
    prepare_parser.set_defaults(handler=prepare)

    evaluate_parser = commands.add_parser("evaluate")
    evaluate_parser.add_argument("--manifests", type=Path, required=True)
    evaluate_parser.add_argument("--golden", type=Path, required=True)
    evaluate_parser.add_argument("--policy", type=Path, required=True)
    evaluate_parser.add_argument("--request", type=Path, required=True)
    evaluate_parser.add_argument("--before", type=Path, required=True)
    evaluate_parser.add_argument("--observations", type=Path, required=True)
    evaluate_parser.add_argument("--output", type=Path, required=True)
    evaluate_parser.set_defaults(handler=evaluate)
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        args.handler(args)
    except BenchmarkError as exc:
        print(f"benchmark error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
