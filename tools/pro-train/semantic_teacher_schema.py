#!/usr/bin/env python
"""Schema and validators for FrameCull Semantic Teacher records.

The grounded teacher record is intentionally stricter than a plain score row:
semanticKeepScore must be backed by region-level reasoningTrace entries and
face validity must be backed by faceRegionVerdicts. Flat-scalar records are
allowed only for the explicit ablation arm.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "framecull-semantic-teacher-v1"

SCENE_TYPES = {
    "portrait",
    "group",
    "environmental_portrait",
    "landscape",
    "empty_scene",
    "documentary_moment",
    "event",
    "product_object",
    "animal",
    "food",
    "other",
}

SCENE_TYPE_ALIASES = {
    "people": "group",
    "crowd": "group",
    "group_photo": "group",
    "group_portrait": "group",
    "person": "portrait",
    "human": "portrait",
    "human_portrait": "portrait",
    "face": "portrait",
    "environmental portrait": "environmental_portrait",
    "environment_portrait": "environmental_portrait",
    "candid_portrait": "environmental_portrait",
    "street_portrait": "environmental_portrait",
    "rural_scene": "landscape",
    "rural": "landscape",
    "scenery": "landscape",
    "scenic": "landscape",
    "nature": "landscape",
    "outdoor": "landscape",
    "cityscape": "landscape",
    "architecture": "landscape",
    "empty": "empty_scene",
    "empty frame": "empty_scene",
    "empty_scene_or_landscape": "empty_scene",
    "still_life": "product_object",
    "object": "product_object",
    "product": "product_object",
    "vehicle": "product_object",
    "car": "product_object",
    "pet": "animal",
    "wildlife": "animal",
    "meal": "food",
    "documentary": "documentary_moment",
    "candid": "documentary_moment",
    "street": "documentary_moment",
    "moment": "documentary_moment",
    "action": "documentary_moment",
    "activity": "event",
    "presentation": "event",
    "professional_presentation": "event",
    "educational_presentation": "event",
    "social_gathering": "event",
    "social_event": "event",
    "professional_event": "event",
    "classroom": "event",
    "educational": "event",
    "lectureship": "event",
    "group_meeting": "event",
    "conference_room_layout": "event",
    "conference": "event",
    "meeting": "event",
    "indoor_activity": "event",
    "office_setup": "event",
    "event_setup": "event",
    "performance": "event",
    "ceremony": "event",
    "indoor": "event",
    "interior": "event",
}

SCORE_FIELDS = [
    "sceneConfidence",
    "subjectConfidence",
    "faceValidityScore",
    "falseFaceRisk",
    "semanticKeepScore",
    "compositionScore",
    "momentScore",
    "lightingMoodScore",
    "storytellingScore",
    "scenicValueScore",
    "technicalVisibleIssueScore",
    "emptyOrFillerScore",
]

REQUIRED_BASE_FIELDS = [
    "schemaVersion",
    "photoId",
    "imagePath",
    "teacherModel",
    "teacherVersion",
    "createdAt",
    "sceneType",
    "sceneConfidence",
    "subjectType",
    "subjectConfidence",
    "hasRealHumanFace",
    "faceValidityScore",
    "falseFaceRisk",
    "semanticKeepScore",
    "compositionScore",
    "momentScore",
    "lightingMoodScore",
    "storytellingScore",
    "scenicValueScore",
    "technicalVisibleIssueScore",
    "emptyOrFillerScore",
    "duplicateRepresentativeHint",
    "keepReasons",
    "rejectReasons",
    "uncertain",
]

GROUNDING_FIELDS = ["reasoningTrace", "faceRegionVerdicts"]

VALID_DUPLICATE_HINTS = {
    "unknown",
    "yes",
    "no",
    "preferred",
    "avoid",
}


def clamp01(value: Any, default: float = 0.5) -> float:
    if value is None:
        number = default
    else:
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = default
    if 1.0 < number <= 100.0:
        number = number / 100.0
    if number < 0.0:
        return 0.0
    if number > 1.0:
        return 1.0
    return number


def slugify_enum(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = text.replace("-", "_").replace("/", "_")
    text = "_".join(part for part in re_split_enum(text) if part)
    return text


def re_split_enum(text: str) -> list[str]:
    # Avoid importing re in hot validators that may be used as a tiny CLI.
    chunks: list[str] = []
    current = []
    for char in text:
        if char.isalnum():
            current.append(char)
        else:
            if current:
                chunks.append("".join(current))
                current = []
    if current:
        chunks.append("".join(current))
    return chunks


def normalize_scene_type(value: Any) -> str:
    raw = str(value or "").strip().lower()
    slug = slugify_enum(raw)
    if slug in SCENE_TYPES:
        return slug
    if raw in SCENE_TYPE_ALIASES:
        return SCENE_TYPE_ALIASES[raw]
    if slug in SCENE_TYPE_ALIASES:
        return SCENE_TYPE_ALIASES[slug]

    words = set(re_split_enum(raw))
    if {"group", "people"} & words or "crowd" in words:
        return "group"
    if {"portrait", "face", "person", "human"} & words:
        return "environmental_portrait" if {"environmental", "street", "candid", "outdoor"} & words else "portrait"
    if {"landscape", "scenery", "scenic", "rural", "nature", "mountain", "river", "cityscape"} & words:
        return "landscape"
    if {"empty", "minimal", "filler"} & words:
        return "empty_scene"
    if {"documentary", "candid", "street", "moment", "action"} & words:
        return "documentary_moment"
    if {"event", "activity", "ceremony", "performance", "stage", "presentation", "lecture", "lecturer", "classroom", "conference", "meeting", "gathering", "indoor", "interior", "setup"} & words:
        return "event"
    if {"product", "object", "vehicle", "car", "bike", "tire"} & words:
        return "product_object"
    if {"animal", "pet", "wildlife", "bird", "dog", "cat"} & words:
        return "animal"
    if {"food", "meal", "dish", "drink"} & words:
        return "food"
    return "other"


def coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"true", "yes", "y", "1", "real", "human"}:
        return True
    if text in {"false", "no", "n", "0", "fake", "none", "unknown"}:
        return False
    return default


def ensure_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def dedupe_preserve_order(items: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def normalize_string_list(value: Any) -> list[str]:
    normalized: list[str] = []
    for item in ensure_list(value):
        if item is None:
            continue
        if isinstance(item, dict):
            if not item:
                continue
            for key, raw in item.items():
                key_text = str(key or "").strip()
                raw_text = str(raw or "").strip()
                if not key_text:
                    continue
                if not raw_text or raw_text.lower() in {"true", "1"}:
                    normalized.append(key_text)
                else:
                    normalized.append(f"{key_text}:{raw_text}")
            continue
        text = str(item).strip()
        if text and text not in {"{}", "[]"}:
            normalized.append(text)
    return dedupe_preserve_order(normalized)


def normalize_reason_list(value: Any, *, reject: bool = False) -> list[str]:
    items = normalize_string_list(value)
    out: list[str] = []
    for text in items:
        lower = text.lower()
        if reject and (
            lower.startswith("there are no significant ")
            or lower.startswith("there are no technical issues")
            or lower.startswith("there are no major technical issues")
            or lower.startswith("no significant technical ")
            or lower.startswith("no major technical ")
            or lower.startswith("no technical issues")
            or lower.startswith("there are no significant issues")
        ):
            continue
        out.append(text)
    return out[:4]


def normalize_box_percent(box: Any) -> Any:
    if not isinstance(box, list) or len(box) != 4:
        return box
    try:
        values = [float(v) for v in box]
    except (TypeError, ValueError):
        return box
    if all(0.0 <= value <= 1.0 for value in values):
        return values
    if all(0.0 <= value <= 100.0 for value in values):
        values = [value / 100.0 for value in values]
        x1, y1, x2, y2 = [max(0.0, min(1.0, value)) for value in values]
        if x2 > x1 and y2 > y1:
            return [round(x1, 6), round(y1, 6), round(x2, 6), round(y2, 6)]
    return box


def normalize_grounding_entries(out: dict[str, Any]) -> None:
    trace = ensure_list(out.get("reasoningTrace"))
    normalized_trace = []
    for item in trace:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        row.setdefault("region", [0.0, 0.0, 1.0, 1.0])
        row["region"] = normalize_box_percent(row["region"])
        row["observation"] = str(row.get("observation") or "unspecified visual evidence").strip()
        row["supportsKeep"] = coerce_bool(row.get("supportsKeep"), default=clamp01(out.get("semanticKeepScore", 0.5)) >= 0.5)
        row["weight"] = clamp01(row.get("weight", 0.5))
        normalized_trace.append(row)
    out["reasoningTrace"] = normalized_trace

    verdicts = ensure_list(out.get("faceRegionVerdicts"))
    normalized_verdicts = []
    for item in verdicts:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        row.setdefault("region", [0.0, 0.0, 1.0, 1.0])
        row["region"] = normalize_box_percent(row["region"])
        row["isRealHumanFace"] = coerce_bool(row.get("isRealHumanFace"), default=False)
        row["evidence"] = str(row.get("evidence") or "unspecified face-region evidence").strip()
        row["confidence"] = clamp01(row.get("confidence", 0.5))
        normalized_verdicts.append(row)
    out["faceRegionVerdicts"] = normalized_verdicts


def normalize_duplicate_hint(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return "unknown"
    text = text.replace("-", "_").replace(" ", "_")
    if text in VALID_DUPLICATE_HINTS:
        return text
    if text in {"true", "1", "pick", "representative"}:
        return "preferred"
    if text in {"false", "0", "skip", "non_representative"}:
        return "avoid"
    return "unknown"


def pick_fallback_region(record: dict[str, Any]) -> list[float]:
    for row in ensure_list(record.get("regions")):
        if isinstance(row, dict) and isinstance(row.get("box"), list) and len(row["box"]) == 4:
            return row["box"]
    for row in ensure_list(record.get("reasoningTrace")):
        if isinstance(row, dict) and isinstance(row.get("region"), list) and len(row["region"]) == 4:
            return row["region"]
    return [0.0, 0.0, 1.0, 1.0]


def validate_box(box: Any, field: str, errors: list[str]) -> None:
    if not isinstance(box, list) or len(box) != 4:
        errors.append(f"{field} must be [x1,y1,x2,y2]")
        return
    try:
        values = [float(v) for v in box]
    except (TypeError, ValueError):
        errors.append(f"{field} box values must be numeric")
        return
    if any(v < 0.0 or v > 1.0 for v in values):
        errors.append(f"{field} box values must be normalized 0..1")
    if values[2] <= values[0] or values[3] <= values[1]:
        errors.append(f"{field} box must have x2>x1 and y2>y1")


def validate_record(record: dict[str, Any], *, allow_flat_scalar: bool = False) -> list[str]:
    errors: list[str] = []
    for field in REQUIRED_BASE_FIELDS:
        if field not in record:
            errors.append(f"missing required field: {field}")
    if not allow_flat_scalar:
        for field in GROUNDING_FIELDS:
            if field not in record:
                errors.append(f"missing grounded field: {field}")
    if record.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {SCHEMA_VERSION}")
    if record.get("sceneType") not in SCENE_TYPES:
        errors.append(f"sceneType must be one of {sorted(SCENE_TYPES)}")

    for field in SCORE_FIELDS:
        if field not in record:
            continue
        try:
            value = float(record[field])
        except (TypeError, ValueError):
            errors.append(f"{field} must be numeric")
            continue
        if value < 0.0 or value > 1.0:
            errors.append(f"{field} must be in 0..1")

    for field in ("keepReasons", "rejectReasons", "uncertain"):
        if field in record and not isinstance(record[field], list):
            errors.append(f"{field} must be a list")

    trace = record.get("reasoningTrace", [])
    if not allow_flat_scalar and (not isinstance(trace, list) or len(trace) == 0):
        errors.append("reasoningTrace must be a non-empty list for grounded mode")
    if isinstance(trace, list):
        for index, item in enumerate(trace):
            if not isinstance(item, dict):
                errors.append(f"reasoningTrace[{index}] must be an object")
                continue
            validate_box(item.get("region"), f"reasoningTrace[{index}].region", errors)
            if not str(item.get("observation", "")).strip():
                errors.append(f"reasoningTrace[{index}].observation is required")
            if "supportsKeep" not in item or not isinstance(item.get("supportsKeep"), bool):
                errors.append(f"reasoningTrace[{index}].supportsKeep must be boolean")
            try:
                weight = float(item.get("weight"))
                if weight < 0.0 or weight > 1.0:
                    errors.append(f"reasoningTrace[{index}].weight must be in 0..1")
            except (TypeError, ValueError):
                errors.append(f"reasoningTrace[{index}].weight must be numeric")

    verdicts = record.get("faceRegionVerdicts", [])
    if not allow_flat_scalar and not isinstance(verdicts, list):
        errors.append("faceRegionVerdicts must be a list")
    if isinstance(verdicts, list):
        for index, item in enumerate(verdicts):
            if not isinstance(item, dict):
                errors.append(f"faceRegionVerdicts[{index}] must be an object")
                continue
            validate_box(item.get("region"), f"faceRegionVerdicts[{index}].region", errors)
            if "isRealHumanFace" not in item or not isinstance(item.get("isRealHumanFace"), bool):
                errors.append(f"faceRegionVerdicts[{index}].isRealHumanFace must be boolean")
            if not str(item.get("evidence", "")).strip():
                errors.append(f"faceRegionVerdicts[{index}].evidence is required")
            try:
                confidence = float(item.get("confidence"))
                if confidence < 0.0 or confidence > 1.0:
                    errors.append(f"faceRegionVerdicts[{index}].confidence must be in 0..1")
            except (TypeError, ValueError):
                errors.append(f"faceRegionVerdicts[{index}].confidence must be numeric")
    if record.get("hasRealHumanFace") and not allow_flat_scalar:
        if not isinstance(verdicts, list) or len(verdicts) == 0:
            errors.append("hasRealHumanFace=true requires faceRegionVerdicts entries")
        elif not any(bool(item.get("isRealHumanFace")) for item in verdicts if isinstance(item, dict)):
            errors.append("hasRealHumanFace=true requires at least one faceRegionVerdicts.isRealHumanFace=true")
    if isinstance(record.get("duplicateRepresentativeHint"), str):
        if record["duplicateRepresentativeHint"] not in VALID_DUPLICATE_HINTS:
            errors.append(f"duplicateRepresentativeHint must be one of {sorted(VALID_DUPLICATE_HINTS)}")
    else:
        errors.append("duplicateRepresentativeHint must be a string")

    return errors


def normalize_record(record: dict[str, Any], *, flat_scalar: bool = False) -> dict[str, Any]:
    out = dict(record)
    out["schemaVersion"] = SCHEMA_VERSION
    original_scene_type = out.get("sceneType")
    out["sceneType"] = normalize_scene_type(original_scene_type)
    out.setdefault("sceneConfidence", 0.5)
    out.setdefault("subjectType", "unknown")
    out.setdefault("subjectConfidence", 0.5)
    out["hasRealHumanFace"] = coerce_bool(out.get("hasRealHumanFace"), default=False)
    out["duplicateRepresentativeHint"] = normalize_duplicate_hint(out.get("duplicateRepresentativeHint"))
    out["keepReasons"] = normalize_reason_list(out.get("keepReasons"), reject=False)
    out["rejectReasons"] = normalize_reason_list(out.get("rejectReasons"), reject=True)
    out["regions"] = ensure_list(out.get("regions"))
    normalized_regions = []
    for item in out["regions"]:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        if "box" in row:
            row["box"] = normalize_box_percent(row["box"])
        normalized_regions.append(row)
    out["regions"] = normalized_regions
    out["uncertain"] = normalize_string_list(out.get("uncertain"))
    if original_scene_type and str(original_scene_type).strip() and out["sceneType"] != slugify_enum(original_scene_type):
        out["uncertain"].append(f"sceneType_normalized_from:{original_scene_type}")
    out.setdefault("reasoningTrace", [] if flat_scalar else [{
        "region": [0.0, 0.0, 1.0, 1.0],
        "observation": "fallback whole-frame observation",
        "supportsKeep": clamp01(out.get("semanticKeepScore", 0.5)) >= 0.5,
        "weight": 1.0,
    }])
    out.setdefault("faceRegionVerdicts", [])
    normalize_grounding_entries(out)
    if not flat_scalar and not out["reasoningTrace"]:
        out["reasoningTrace"] = [{
            "region": [0.0, 0.0, 1.0, 1.0],
            "observation": "fallback whole-frame observation",
            "supportsKeep": clamp01(out.get("semanticKeepScore", 0.5)) >= 0.5,
            "weight": 1.0,
        }]
        out["uncertain"].append("reasoningTrace_fallback")
    if not flat_scalar and out["hasRealHumanFace"]:
        if not out["faceRegionVerdicts"]:
            out["faceRegionVerdicts"] = [{
                "region": pick_fallback_region(out),
                "isRealHumanFace": False,
                "evidence": "teacher declared a human face but did not localize a real face region; keeping conservative false fallback",
                "confidence": clamp01(1.0 - float(out.get("faceValidityScore", 0.6)), default=0.6),
            }]
            out["hasRealHumanFace"] = False
            out["faceValidityScore"] = min(clamp01(out.get("faceValidityScore", 0.6), default=0.6), 0.4)
            out["falseFaceRisk"] = max(clamp01(out.get("falseFaceRisk", 0.4), default=0.4), 0.6)
            out["uncertain"].append("faceRegionVerdicts_false_fallback")
        elif not any(bool(item.get("isRealHumanFace")) for item in out["faceRegionVerdicts"] if isinstance(item, dict)):
            out["hasRealHumanFace"] = False
            out["faceValidityScore"] = min(clamp01(out.get("faceValidityScore", 0.6), default=0.6), 0.4)
            out["falseFaceRisk"] = max(clamp01(out.get("falseFaceRisk", 0.4), default=0.4), 0.6)
            out["uncertain"].append("faceRegionVerdicts_false_suppressed")
    missing_scores = []
    null_scores = []
    for field in SCORE_FIELDS:
        if field not in out:
            missing_scores.append(field)
        elif out[field] is None:
            null_scores.append(field)
        out[field] = clamp01(out.get(field, 0.5))
    if missing_scores:
        out["uncertain"].append("missing_score_fields:" + ",".join(missing_scores))
    if null_scores:
        out["uncertain"].append("null_score_fields:" + ",".join(null_scores))
    return out


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            try:
                yield line_no, json.loads(text)
            except json.JSONDecodeError as error:
                yield line_no, {"__json_error__": str(error)}


def validate_jsonl(path: Path, *, allow_flat_scalar: bool = False) -> dict[str, Any]:
    total = 0
    failed = 0
    failures = []
    scene_counts: dict[str, int] = {}
    for line_no, record in iter_jsonl(path):
        total += 1
        if "__json_error__" in record:
            errors = [record["__json_error__"]]
        else:
            errors = validate_record(record, allow_flat_scalar=allow_flat_scalar)
            scene = str(record.get("sceneType", "unknown"))
            scene_counts[scene] = scene_counts.get(scene, 0) + 1
        if errors:
            failed += 1
            failures.append({"line": line_no, "photoId": record.get("photoId"), "errors": errors[:8]})
    return {
        "path": str(path),
        "allowFlatScalar": allow_flat_scalar,
        "total": total,
        "failed": failed,
        "passed": failed == 0,
        "sceneCounts": scene_counts,
        "failures": failures[:200],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl", type=Path)
    parser.add_argument("--allow-flat-scalar", action="store_true")
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    result = validate_jsonl(args.jsonl, allow_flat_scalar=args.allow_flat_scalar)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
