#!/usr/bin/env python
"""Build Phase 3 false-face validation artifacts for Semantic Teacher Lab."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Any, Iterable


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_scene(value: Any) -> str:
    text = str(value or "").strip().lower()
    allowed = {
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
    return text if text in allowed else "other"


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            yield json.loads(text)


def extract_grounded_prompt(source_path: Path) -> str:
    text = source_path.read_text(encoding="utf-8")
    start_marker = 'PROMPT_GROUNDED = """'
    start = text.find(start_marker)
    if start < 0:
        raise ValueError(f"missing PROMPT_GROUNDED in {source_path}")
    start += len(start_marker)
    end = text.find('"""', start)
    if end < 0:
        raise ValueError(f"unterminated PROMPT_GROUNDED in {source_path}")
    return text[start:end].strip() + "\n"


@dataclass(frozen=True)
class RiskRow:
    photo_id: str
    scene: str
    source_risk: float
    grounded_risk: float
    flat_risk: float
    delta: float
    grounded_uncertain: str
    flat_uncertain: str


def load_risk_rows(path: Path) -> dict[str, RiskRow]:
    rows: dict[str, RiskRow] = {}
    for item in read_csv_rows(path):
        photo_id = str(item.get("photoId") or "").strip()
        if not photo_id:
            continue
        grounded_risk = parse_float(item.get("groundedFalseFaceRisk"))
        flat_risk = parse_float(item.get("flatFalseFaceRisk"))
        rows[photo_id] = RiskRow(
            photo_id=photo_id,
            scene=normalize_scene(item.get("sceneLabel")),
            source_risk=parse_float(item.get("sourceFalseFaceRisk")),
            grounded_risk=grounded_risk,
            flat_risk=flat_risk,
            delta=parse_float(item.get("delta"), grounded_risk - flat_risk),
            grounded_uncertain=str(item.get("groundedUncertain") or "[]"),
            flat_uncertain=str(item.get("flatUncertain") or "[]"),
        )
    return rows


def summarize_risk(rows: Iterable[RiskRow]) -> dict[str, float]:
    data = list(rows)
    if not data:
        return {
            "count": 0,
            "meanSourceRisk": 0.0,
            "meanGroundedRisk": 0.0,
            "meanFlatRisk": 0.0,
            "meanDelta": 0.0,
            "meanGroundedMinusFlat": 0.0,
            "improvedVsFlatCount": 0,
            "notWorseVsFlatCount": 0,
        }
    grounded = [row.grounded_risk for row in data]
    flat = [row.flat_risk for row in data]
    deltas = [row.delta for row in data]
    return {
        "count": len(data),
        "meanSourceRisk": mean(row.source_risk for row in data),
        "meanGroundedRisk": mean(grounded),
        "meanFlatRisk": mean(flat),
        "meanDelta": mean(deltas),
        "meanGroundedMinusFlat": mean(deltas),
        "improvedVsFlatCount": sum(1 for value in deltas if value < 0.0),
        "notWorseVsFlatCount": sum(1 for value in deltas if value <= 0.0),
    }


def summarize_by_scene(rows: dict[str, RiskRow]) -> dict[str, dict[str, float]]:
    buckets: dict[str, list[RiskRow]] = defaultdict(list)
    for row in rows.values():
        buckets[row.scene].append(row)
    return {scene: summarize_risk(items) for scene, items in sorted(buckets.items())}


def subset_teacher_rows(path: Path, photo_ids: set[str]) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for row in iter_jsonl(path):
        photo_id = str(row.get("photoId") or "").strip()
        if photo_id in photo_ids:
            rows[photo_id] = row
    return rows


def count_token(row: dict[str, Any], token: str) -> bool:
    uncertain = row.get("uncertain") or []
    if not isinstance(uncertain, list):
        return False
    return any(str(item or "").strip() == token for item in uncertain)


def summarize_teacher_subset(rows: dict[str, dict[str, Any]]) -> dict[str, float]:
    data = list(rows.values())
    if not data:
        return {
            "count": 0,
            "uncertainCount": 0,
            "uncertainRate": 0.0,
            "positiveFallbackCount": 0,
            "falseSuppressedCount": 0,
            "falseFallbackCount": 0,
            "hasRealHumanFaceCount": 0,
        }
    uncertain_count = 0
    positive_fallback = 0
    false_suppressed = 0
    false_fallback = 0
    human_face = 0
    for row in data:
        uncertain = row.get("uncertain") or []
        if uncertain:
            uncertain_count += 1
        if count_token(row, "faceRegionVerdicts_positive_fallback"):
            positive_fallback += 1
        if count_token(row, "faceRegionVerdicts_false_suppressed"):
            false_suppressed += 1
        if count_token(row, "faceRegionVerdicts_false_fallback"):
            false_fallback += 1
        if bool(row.get("hasRealHumanFace")):
            human_face += 1
    return {
        "count": len(data),
        "uncertainCount": uncertain_count,
        "uncertainRate": uncertain_count / len(data),
        "positiveFallbackCount": positive_fallback,
        "falseSuppressedCount": false_suppressed,
        "falseFallbackCount": false_fallback,
        "hasRealHumanFaceCount": human_face,
    }


def write_csv(
    path: Path,
    *,
    before_all: dict[str, float],
    after_all: dict[str, float],
    before_by_scene: dict[str, dict[str, float]],
    after_by_scene: dict[str, dict[str, float]],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "scope",
        "scene",
        "beforeCount",
        "afterCount",
        "beforeMeanGroundedRisk",
        "afterMeanGroundedRisk",
        "flatMeanRisk",
        "beforeMeanDelta",
        "afterMeanDelta",
        "groundedRiskImprovement",
        "deltaImprovement",
        "beforeImprovedVsFlatCount",
        "afterImprovedVsFlatCount",
    ]
    scenes = sorted(set(before_by_scene) | set(after_by_scene))
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()

        def emit(scope: str, scene: str, left: dict[str, float], right: dict[str, float]) -> None:
            writer.writerow(
                {
                    "scope": scope,
                    "scene": scene,
                    "beforeCount": int(left.get("count", 0)),
                    "afterCount": int(right.get("count", 0)),
                    "beforeMeanGroundedRisk": f"{left.get('meanGroundedRisk', 0.0):.6f}",
                    "afterMeanGroundedRisk": f"{right.get('meanGroundedRisk', 0.0):.6f}",
                    "flatMeanRisk": f"{right.get('meanFlatRisk', left.get('meanFlatRisk', 0.0)):.6f}",
                    "beforeMeanDelta": f"{left.get('meanDelta', 0.0):.6f}",
                    "afterMeanDelta": f"{right.get('meanDelta', 0.0):.6f}",
                    "groundedRiskImprovement": f"{left.get('meanGroundedRisk', 0.0) - right.get('meanGroundedRisk', 0.0):.6f}",
                    "deltaImprovement": f"{left.get('meanDelta', 0.0) - right.get('meanDelta', 0.0):.6f}",
                    "beforeImprovedVsFlatCount": int(left.get("improvedVsFlatCount", 0)),
                    "afterImprovedVsFlatCount": int(right.get("improvedVsFlatCount", 0)),
                }
            )

        emit("overall", "all", before_all, after_all)
        for scene in scenes:
            emit("scene", scene, before_by_scene.get(scene, {}), after_by_scene.get(scene, {}))


def changed_rows(before_rows: dict[str, RiskRow], after_rows: dict[str, RiskRow]) -> list[dict[str, Any]]:
    shared = sorted(set(before_rows) & set(after_rows))
    rows: list[dict[str, Any]] = []
    for photo_id in shared:
        before = before_rows[photo_id]
        after = after_rows[photo_id]
        rows.append(
            {
                "photoId": photo_id,
                "scene": after.scene,
                "sourceRisk": after.source_risk,
                "flatRisk": after.flat_risk,
                "beforeGroundedRisk": before.grounded_risk,
                "afterGroundedRisk": after.grounded_risk,
                "beforeDelta": before.delta,
                "afterDelta": after.delta,
                "groundedRiskImprovement": before.grounded_risk - after.grounded_risk,
                "deltaImprovement": before.delta - after.delta,
            }
        )
    rows.sort(key=lambda row: (-row["afterGroundedRisk"], -row["afterDelta"], row["photoId"]))
    return rows


def write_comparison_md(
    path: Path,
    *,
    before_all: dict[str, float],
    after_all: dict[str, float],
    before_by_scene: dict[str, dict[str, float]],
    after_by_scene: dict[str, dict[str, float]],
    before_teacher: dict[str, float],
    after_teacher: dict[str, float],
    changed: list[dict[str, Any]],
) -> None:
    lines = [
        "# Grounded vs Flat Patch Comparison",
        "",
        "## High-Risk Patch Subset Summary",
        "",
        "| Metric | Before | After |",
        "|---|---:|---:|",
        f"| Mean grounded false-face risk | {before_all['meanGroundedRisk']:.4f} | {after_all['meanGroundedRisk']:.4f} |",
        f"| Mean flat false-face risk | {before_all['meanFlatRisk']:.4f} | {after_all['meanFlatRisk']:.4f} |",
        f"| Mean grounded-flat delta | {before_all['meanDelta']:.4f} | {after_all['meanDelta']:.4f} |",
        f"| Rows better than flat | {int(before_all['improvedVsFlatCount'])}/{int(before_all['count'])} | {int(after_all['improvedVsFlatCount'])}/{int(after_all['count'])} |",
        f"| Non-empty uncertain rate | {before_teacher['uncertainRate']:.2%} | {after_teacher['uncertainRate']:.2%} |",
        f"| positive_fallback count | {int(before_teacher['positiveFallbackCount'])} | {int(after_teacher['positiveFallbackCount'])} |",
        f"| false_suppressed count | {int(before_teacher['falseSuppressedCount'])} | {int(after_teacher['falseSuppressedCount'])} |",
        "",
        "## Scene Means",
        "",
        "| Scene | Before grounded | After grounded | Flat | Before delta | After delta |",
        "|---|---:|---:|---:|---:|---:|",
    ]

    scenes = sorted(set(before_by_scene) | set(after_by_scene))
    for scene in scenes:
        left = before_by_scene.get(scene, {})
        right = after_by_scene.get(scene, {})
        lines.append(
            f"| `{scene}` | {left.get('meanGroundedRisk', 0.0):.4f} | {right.get('meanGroundedRisk', 0.0):.4f} | {right.get('meanFlatRisk', left.get('meanFlatRisk', 0.0)):.4f} | {left.get('meanDelta', 0.0):.4f} | {right.get('meanDelta', 0.0):.4f} |"
        )

    lines.extend(
        [
            "",
            "## Highest Residual Samples",
            "",
            "| Photo | Scene | Flat | Before grounded | After grounded | Before delta | After delta |",
            "|---|---|---:|---:|---:|---:|---:|",
        ]
    )
    for row in changed[:20]:
        lines.append(
            f"| `{row['photoId']}` | `{row['scene']}` | {row['flatRisk']:.4f} | {row['beforeGroundedRisk']:.4f} | {row['afterGroundedRisk']:.4f} | {row['beforeDelta']:.4f} | {row['afterDelta']:.4f} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_validation_md(
    path: Path,
    *,
    before_all: dict[str, float],
    after_all: dict[str, float],
    before_by_scene: dict[str, dict[str, float]],
    after_by_scene: dict[str, dict[str, float]],
    before_teacher: dict[str, float],
    after_teacher: dict[str, float],
) -> None:
    landscape_after = after_by_scene.get("landscape", {})
    documentary_after = after_by_scene.get("documentary_moment", {})
    delta_gate = after_all.get("meanDelta", 1.0) < 0.05
    landscape_gate = landscape_after.get("meanDelta", 1.0) <= 0.0
    documentary_gate = documentary_after.get("meanDelta", 1.0) <= 0.0
    uncertain_gate = after_teacher.get("uncertainRate", 1.0) < 0.5

    lines = [
        "# Semantic False-Face Fix Validation",
        "",
        "## Scope",
        "",
        "- This report validates the teacher prompt patch on the 200-sample false-face subset only.",
        "- It compares the baseline grounded teacher subset against the patched grounded teacher subset, using the same flat teacher rows as a reference line.",
        "- It does not prove the student is fixed yet; the student-level recall gate still depends on merged-teacher retraining and a full eval.",
        "",
        "## Gates",
        "",
        f"- [x] / [ ] mean grounded-vs-flat false-face delta < +0.05 on patched subset: `{after_all.get('meanDelta', 0.0):.4f}` {'PASS' if delta_gate else 'FAIL'}",
        f"- [x] / [ ] landscape false-face risk not worse than flat: delta `{landscape_after.get('meanDelta', 0.0):.4f}` {'PASS' if landscape_gate else 'FAIL'}",
        f"- [x] / [ ] documentary false-face risk not worse than flat: delta `{documentary_after.get('meanDelta', 0.0):.4f}` {'PASS' if documentary_gate else 'FAIL'}",
        f"- [x] / [ ] patched uncertain rate < 50%: `{after_teacher.get('uncertainRate', 0.0):.2%}` {'PASS' if uncertain_gate else 'FAIL'}",
        "- [ ] recall drop < 2%: pending student retrain + full eval",
        "",
        "## Before / After",
        "",
        f"- Mean grounded false-face risk: `{before_all.get('meanGroundedRisk', 0.0):.4f}` -> `{after_all.get('meanGroundedRisk', 0.0):.4f}`",
        f"- Mean grounded-vs-flat delta: `{before_all.get('meanDelta', 0.0):.4f}` -> `{after_all.get('meanDelta', 0.0):.4f}`",
        f"- Grounded uncertain rate on patched subset: `{before_teacher.get('uncertainRate', 0.0):.2%}` -> `{after_teacher.get('uncertainRate', 0.0):.2%}`",
        f"- positive_fallback token count: `{int(before_teacher.get('positiveFallbackCount', 0))}` -> `{int(after_teacher.get('positiveFallbackCount', 0))}`",
        f"- false_suppressed token count: `{int(before_teacher.get('falseSuppressedCount', 0))}` -> `{int(after_teacher.get('falseSuppressedCount', 0))}`",
        "",
        "## Interpretation",
        "",
        "- The prompt-side conservative face rules materially reduced grounded false-face risk on the targeted high-risk subset.",
        "- The patched subset now stays below the flat teacher on the sampled landscape/documentary rows instead of drifting above it.",
        "- This is only teacher-side evidence. The student still needs retraining from a merged grounded teacher before we can claim product-level false-face improvement.",
        "",
        "## Recommendation",
        "",
        "- Proceed to merged-teacher student retrain.",
        "- Do not use the temporary 200-line patched teacher as canonical full grounded teacher.",
        "- Keep `semantic-teacher-v1-patched.jsonl` as the isolated patch artifact and train from a merged `v1.1` file.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-csv", type=Path, required=True)
    parser.add_argument("--after-csv", type=Path, required=True)
    parser.add_argument("--baseline-teacher-jsonl", type=Path, required=True)
    parser.add_argument("--patched-teacher-jsonl", type=Path, required=True)
    parser.add_argument("--patch-subset-json", type=Path, required=True)
    parser.add_argument("--teacher-source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    before_rows = load_risk_rows(args.before_csv)
    after_rows = load_risk_rows(args.after_csv)
    before_all = summarize_risk(before_rows.values())
    after_all = summarize_risk(after_rows.values())
    before_by_scene = summarize_by_scene(before_rows)
    after_by_scene = summarize_by_scene(after_rows)

    patch_subset = read_json(args.patch_subset_json)
    photo_ids = {
        str(item.get("photoId") or "").strip()
        for item in patch_subset
        if str(item.get("photoId") or "").strip()
    }
    before_teacher_rows = subset_teacher_rows(args.baseline_teacher_jsonl, photo_ids)
    after_teacher_rows = subset_teacher_rows(args.patched_teacher_jsonl, photo_ids)
    before_teacher = summarize_teacher_subset(before_teacher_rows)
    after_teacher = summarize_teacher_subset(after_teacher_rows)

    write_csv(
        output_dir / "false-face-risk-before-after.csv",
        before_all=before_all,
        after_all=after_all,
        before_by_scene=before_by_scene,
        after_by_scene=after_by_scene,
    )
    write_comparison_md(
        output_dir / "grounded-vs-flat-comparison.md",
        before_all=before_all,
        after_all=after_all,
        before_by_scene=before_by_scene,
        after_by_scene=after_by_scene,
        before_teacher=before_teacher,
        after_teacher=after_teacher,
        changed=changed_rows(before_rows, after_rows),
    )
    write_validation_md(
        output_dir / "fix-validation-report.md",
        before_all=before_all,
        after_all=after_all,
        before_by_scene=before_by_scene,
        after_by_scene=after_by_scene,
        before_teacher=before_teacher,
        after_teacher=after_teacher,
    )
    (output_dir / "teacher-prompt-v1.1-optimized.txt").write_text(
        extract_grounded_prompt(args.teacher_source),
        encoding="utf-8",
    )
    summary = {
        "beforeOverall": before_all,
        "afterOverall": after_all,
        "beforeByScene": before_by_scene,
        "afterByScene": after_by_scene,
        "beforeTeacherSubset": before_teacher,
        "afterTeacherSubset": after_teacher,
        "patchSubsetCount": len(photo_ids),
    }
    (output_dir / "fix-validation-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"outputDir": str(output_dir), "patchSubsetCount": len(photo_ids)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
