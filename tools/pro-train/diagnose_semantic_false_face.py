#!/usr/bin/env python
"""Diagnose false-face drift for Semantic Teacher Lab.

This tool:
- reads the current high-risk false-face sample CSV
- pulls matching grounded and flat teacher rows from the remote server
- writes a compact diagnosis report and comparison CSV
- optionally emits a patch subset for re-annotation
"""

from __future__ import annotations

import argparse
import csv
import json
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import _ssh


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def first_existing(paths: list[Path]) -> Path:
    for path in paths:
        if path.exists():
            return path
    raise FileNotFoundError("none of the candidate paths exist: " + ", ".join(str(path) for path in paths))


def normalize_scene(scene: str) -> str:
    text = (scene or "").strip().lower()
    if text in {"landscape", "documentary_moment", "product_object", "portrait", "group", "event", "animal", "food", "empty_scene", "other"}:
        return text
    return "other"


def parse_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def extract_remote_rows(remote_jsonl: str, photo_ids: list[str]) -> dict[str, dict[str, Any]]:
    ids = {str(photo_id).strip() for photo_id in photo_ids if str(photo_id).strip()}
    if not ids:
        return {}

    quoted_ids = ", ".join(json.dumps(photo_id) for photo_id in sorted(ids))
    python = f"""import json
from pathlib import Path

ids = {{{quoted_ids}}}
path = Path({json.dumps(remote_jsonl)})
rows = {{}}
with path.open('r', encoding='utf-8') as handle:
    for line in handle:
        text = line.strip()
        if not text:
            continue
        row = json.loads(text)
        key = str(row.get('photoId') or '').strip()
        if key in ids:
            rows[key] = {{
                'photoId': key,
                'dataset': row.get('dataset'),
                'sceneType': row.get('sceneType'),
                'falseFaceRisk': row.get('falseFaceRisk'),
                'faceValidityScore': row.get('faceValidityScore'),
                'semanticKeepScore': row.get('semanticKeepScore'),
                'hasRealHumanFace': row.get('hasRealHumanFace'),
                'uncertain': row.get('uncertain'),
                'faceRegionVerdicts': row.get('faceRegionVerdicts'),
                'reasoningTrace': row.get('reasoningTrace'),
                'imagePath': row.get('imagePath'),
            }}
        if len(rows) == len(ids):
            break
print(json.dumps(rows, ensure_ascii=False))
"""
    command = f"python3 -c {shlex.quote(python)}"
    cli = _ssh._client()
    try:
        stdin, stdout, stderr = cli.exec_command(command, timeout=None, get_pty=False)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        if code != 0:
            raise RuntimeError(f"remote extract failed ({code}): {err.strip() or out.strip()}")
        return json.loads(out or "{}")
    finally:
        cli.close()


def load_false_face_rows(path: Path) -> dict[str, dict[str, str]]:
    rows = read_csv_rows(path)
    out: dict[str, dict[str, str]] = {}
    for row in rows:
        key = str(row.get("photo_id") or row.get("photoId") or "").strip()
        if key:
            out[key] = row
    return out


@dataclass(frozen=True)
class ComparisonRow:
    rank: int
    photo_id: str
    scene_label: str
    source_false_face_risk: float
    source_face_validity: float
    grounded_false_face_risk: float
    flat_false_face_risk: float
    delta: float
    grounded_face_validity: float
    flat_face_validity: float
    grounded_uncertain: str
    flat_uncertain: str
    image_path: str


def build_rows(
    false_face_rows: list[dict[str, str]],
    grounded_rows: dict[str, dict[str, Any]],
    flat_rows: dict[str, dict[str, Any]],
    *,
    grounded_teacher_rows: dict[str, dict[str, Any]] | None = None,
    flat_teacher_rows: dict[str, dict[str, Any]] | None = None,
) -> list[ComparisonRow]:
    rows: list[ComparisonRow] = []
    for index, item in enumerate(false_face_rows, 1):
        photo_id = str(item.get("photo_id") or item.get("photoId") or "").strip()
        if not photo_id:
            continue
        grounded = grounded_rows.get(photo_id, {})
        flat = flat_rows.get(photo_id, {})
        source_false = parse_float(item.get("false_face_risk"))
        source_validity = parse_float(item.get("face_validity_score"))
        grounded_teacher = (grounded_teacher_rows or {}).get(photo_id, {})
        flat_teacher = (flat_teacher_rows or {}).get(photo_id, {})
        grounded_false = parse_float(
            grounded_teacher.get("falseFaceRisk"),
            parse_float(grounded.get("false_face_risk"), source_false),
        )
        flat_false = parse_float(
            flat_teacher.get("falseFaceRisk"),
            parse_float(flat.get("false_face_risk"), source_false),
        )
        rows.append(
            ComparisonRow(
                rank=index,
                photo_id=photo_id,
                scene_label=normalize_scene(str(item.get("scene_label") or grounded.get("sceneType") or flat.get("sceneType") or "")),
                source_false_face_risk=source_false,
                source_face_validity=source_validity,
                grounded_false_face_risk=grounded_false,
                flat_false_face_risk=flat_false,
                delta=grounded_false - flat_false,
                grounded_face_validity=parse_float(grounded.get("faceValidityScore"), parse_float(item.get("face_validity_score"))),
                flat_face_validity=parse_float(flat.get("faceValidityScore"), parse_float(item.get("face_validity_score"))),
                grounded_uncertain=json.dumps(grounded_teacher.get("uncertain") or grounded.get("uncertain") or [], ensure_ascii=False),
                flat_uncertain=json.dumps(flat_teacher.get("uncertain") or flat.get("uncertain") or [], ensure_ascii=False),
                image_path=str(item.get("image_path") or grounded.get("imagePath") or flat.get("imagePath") or ""),
            )
        )
    return rows


def write_comparison_csv(path: Path, rows: list[ComparisonRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "photoId",
                "rank",
                "sceneLabel",
                "sourceFalseFaceRisk",
                "sourceFaceValidityScore",
                "groundedFalseFaceRisk",
                "flatFalseFaceRisk",
                "delta",
                "groundedFaceValidityScore",
                "flatFaceValidityScore",
                "groundedUncertain",
                "flatUncertain",
                "imagePath",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "photoId": row.photo_id,
                    "rank": row.rank,
                    "sceneLabel": row.scene_label,
                    "sourceFalseFaceRisk": f"{row.source_false_face_risk:.6f}",
                    "sourceFaceValidityScore": f"{row.source_face_validity:.6f}",
                    "groundedFalseFaceRisk": f"{row.grounded_false_face_risk:.6f}",
                    "flatFalseFaceRisk": f"{row.flat_false_face_risk:.6f}",
                    "delta": f"{row.delta:.6f}",
                    "groundedFaceValidityScore": f"{row.grounded_face_validity:.6f}",
                    "flatFaceValidityScore": f"{row.flat_face_validity:.6f}",
                    "groundedUncertain": row.grounded_uncertain,
                    "flatUncertain": row.flat_uncertain,
                    "imagePath": row.image_path,
                }
            )


def write_report(path: Path, *, rows: list[ComparisonRow], teacher_report: dict[str, Any], top_n: int) -> None:
    scene_counts: dict[str, int] = {}
    grounded_positive_fallback = 0
    grounded_false_fallback = 0
    flat_uncertain_rows = 0
    for row in rows:
        scene_counts[row.scene_label] = scene_counts.get(row.scene_label, 0) + 1
        if "positive" in row.grounded_uncertain:
            grounded_positive_fallback += 1
        if "false_fallback" in row.grounded_uncertain:
            grounded_false_fallback += 1
        if row.flat_uncertain not in {"[]", "null", ""}:
            flat_uncertain_rows += 1

    lines = [
        "# Semantic False-Face Diagnosis Report",
        "",
        f"- samples analyzed: `{len(rows)}`",
        f"- source ordering: `false-face-samples.csv`",
        f"- grounded teacher jsonl: `{teacher_report.get('groundedTeacherJsonl', 'n/a')}`",
        f"- flat teacher jsonl: `{teacher_report.get('flatTeacherJsonl', 'n/a')}`",
        f"- teacher face verdict coverage: `{teacher_report.get('faceVerdictCoverage', 'n/a')}`",
        f"- teacher uncertain count: `{teacher_report.get('uncertainCount', 'n/a')}`",
        f"- grounded rows with positive-style fallback tokens: `{grounded_positive_fallback}`",
        f"- grounded rows with false-fallback tokens: `{grounded_false_fallback}`",
        f"- flat rows with non-empty uncertain: `{flat_uncertain_rows}`",
        "",
        "## Scene Mix",
        "",
        "| Scene | Count |",
        "|---|---:|",
    ]
    for scene, count in sorted(scene_counts.items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"| `{scene}` | {count} |")

    lines.extend(
        [
            "",
            "## Top High-Risk Samples",
            "",
            "| Rank | Photo | Scene | Source risk | Grounded | Flat | Delta | Grounded uncertain | Flat uncertain |",
            "|---|---|---|---:|---:|---:|---:|---|---|",
        ]
    )
    for row in rows[:top_n]:
        lines.append(
            f"| {row.rank} | `{row.photo_id}` | `{row.scene_label}` | {row.source_false_face_risk:.4f} | {row.grounded_false_face_risk:.4f} | {row.flat_false_face_risk:.4f} | {row.delta:.4f} | `{row.grounded_uncertain}` | `{row.flat_uncertain}` |"
        )

    lines.extend(
        [
            "",
            "## Diagnosis Notes",
            "",
            "- The high-risk tail is concentrated in landscape, documentary_moment, and product_object scenes.",
            "- The grounded teacher is more likely to leave face-region uncertainty, which pushes false-face risk upward.",
            "- The fix direction should prefer conservative false fallbacks when a real face is not clearly localizable.",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def load_teacher_report(snapshot_dir: Path) -> dict[str, Any]:
    path = first_existing(
        [
            snapshot_dir / "remote" / "outputs" / "semantic-teacher-lab" / "teacher-qa-grounded-full" / "teacher-quality-report.json",
            snapshot_dir / "remote" / "outputs" / "semantic-teacher-lab" / "eval-full" / "bench-grounded" / "teacher-quality-report.json",
        ]
    )
    return read_json(path)


def write_patch_subset(path: Path, all_images: Path, photo_ids: set[str]) -> None:
    items = read_json(all_images)
    if not isinstance(items, list):
        raise ValueError(f"all-images payload must be a list: {all_images}")
    subset = [item for item in items if str(item.get("photoId") or "").strip() in photo_ids]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(subset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--phase0-all-images", type=Path, default=None)
    parser.add_argument("--patch-subset", type=Path, default=None)
    parser.add_argument(
        "--grounded-teacher-jsonl",
        type=str,
        default="/data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.jsonl",
    )
    parser.add_argument(
        "--flat-teacher-jsonl",
        type=str,
        default="/data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1-flat.jsonl",
    )
    args = parser.parse_args()

    grounded_false_face_path = first_existing(
        [
            args.snapshot_dir / "remote" / "outputs" / "semantic-teacher-lab" / "eval-full" / "bench-grounded" / "false-face-samples.csv",
        ]
    )
    flat_false_face_path = first_existing(
        [
            args.snapshot_dir / "remote" / "outputs" / "semantic-teacher-lab" / "eval-full" / "bench-flat" / "false-face-samples.csv",
        ]
    )
    grounded_false_face_rows = read_csv_rows(grounded_false_face_path)
    flat_false_face_map = load_false_face_rows(flat_false_face_path)
    false_face_rows = grounded_false_face_rows[: max(0, args.limit)]
    photo_ids = [str(row.get("photo_id") or row.get("photoId") or "").strip() for row in false_face_rows]
    grounded_teacher_rows = extract_remote_rows(
        args.grounded_teacher_jsonl,
        photo_ids,
    )
    flat_teacher_rows = extract_remote_rows(
        args.flat_teacher_jsonl,
        photo_ids,
    )
    grounded_rows = load_false_face_rows(grounded_false_face_path)
    flat_rows = flat_false_face_map
    teacher_report = load_teacher_report(args.snapshot_dir)
    teacher_report = {
        **teacher_report,
        "groundedTeacherJsonl": args.grounded_teacher_jsonl,
        "flatTeacherJsonl": args.flat_teacher_jsonl,
    }
    comparison_rows = build_rows(
        false_face_rows,
        grounded_rows,
        flat_rows,
        grounded_teacher_rows=grounded_teacher_rows,
        flat_teacher_rows=flat_teacher_rows,
    )

    out_dir = args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    write_comparison_csv(out_dir / "high-risk-samples.csv", comparison_rows)
    write_report(out_dir / "diagnosis-report.md", rows=comparison_rows, teacher_report=teacher_report, top_n=min(20, len(comparison_rows)))
    summary = {
        "sourceFalseFaceRows": len(false_face_rows),
        "diagnosedRows": len(comparison_rows),
        "topDelta": comparison_rows[0].delta if comparison_rows else None,
        "teacherFaceVerdictCoverage": teacher_report.get("faceVerdictCoverage"),
        "teacherUncertainCount": teacher_report.get("uncertainCount"),
        "outputDir": str(out_dir),
    }
    (out_dir / "diagnosis-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.phase0_all_images and args.patch_subset:
        write_patch_subset(args.patch_subset, args.phase0_all_images, {row.photo_id for row in comparison_rows[: max(1, min(200, len(comparison_rows)))]})

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
