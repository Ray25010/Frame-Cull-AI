#!/usr/bin/env python
"""Write false-face independent-set generalization reports for v12/v13.

This script supports two modes:
1. single-run summary (current v12 style)
2. retrain comparison (baseline v12 vs new v13 on the same zero-overlap holdout)
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from pathlib import Path
from typing import Any


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def median(values: list[float]) -> float:
    return float(statistics.median(values)) if values else 0.0


def mean(values: list[float]) -> float:
    return float(statistics.fmean(values)) if values else 0.0


def auc(pos: list[float], neg: list[float]) -> float:
    if not pos or not neg:
        return 0.0
    wins = 0.0
    total = len(pos) * len(neg)
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1.0
            elif p == n:
                wins += 0.5
    return wins / total


def quantile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    lower = int(pos)
    upper = min(lower + 1, len(ordered) - 1)
    frac = pos - lower
    return float(ordered[lower] * (1.0 - frac) + ordered[upper] * frac)


def summarize(values: list[float], threshold: float) -> dict[str, float]:
    return {
        "count": len(values),
        "mean": mean(values),
        "median": median(values),
        "min": min(values) if values else 0.0,
        "p25": quantile(values, 0.25),
        "p75": quantile(values, 0.75),
        "max": max(values) if values else 0.0,
        "hitRateGeThreshold": (sum(1 for value in values if value >= threshold) / len(values)) if values else 0.0,
    }


def fmt(value: float) -> str:
    return f"{value:.4f}"


def pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2%}"


def signed_pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:+.2%}"


def write_scores_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = [
        "photoId",
        "sampleRole",
        "hasRealHumanFace",
        "manualScene",
        "modelScene",
        "falseFaceRisk",
        "faceValidityScore",
        "semanticKeepScore",
        "personaScore",
        "imagePath",
        "illusionReason",
        "error",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def label_map(independent_rows: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    return {row["photoId"]: row for row in independent_rows}


def normalize_rows(labels: dict[str, dict[str, str]], raw: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in raw.get("results") or []:
        photo_id = str(item.get("photoId") or "").strip()
        label = labels.get(photo_id, {})
        out.append(
            {
                "photoId": photo_id,
                "sampleRole": label.get("sampleRole", ""),
                "hasRealHumanFace": label.get("hasRealHumanFace", ""),
                "manualScene": label.get("scene", ""),
                "modelScene": item.get("sceneLabel", ""),
                "falseFaceRisk": to_float(item.get("falseFaceRisk")),
                "faceValidityScore": to_float(item.get("faceValidityScore")),
                "semanticKeepScore": to_float(item.get("semanticKeepScore")),
                "personaScore": to_float(item.get("personaScore")),
                "imagePath": label.get("absolutePath") or item.get("imagePath", ""),
                "illusionReason": label.get("illusionReason", ""),
                "error": item.get("error") or "",
            }
        )
    return out


def summarize_rows(rows: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    positives = [row for row in rows if row["sampleRole"] == "false_face_positive"]
    controls = [row for row in rows if row["sampleRole"] == "real_face_control"]
    pos_scores = [float(row["falseFaceRisk"]) for row in positives if not row.get("error")]
    control_scores = [float(row["falseFaceRisk"]) for row in controls if not row.get("error")]
    pos_summary = summarize(pos_scores, threshold)
    control_summary = summarize(control_scores, threshold)
    score_auc = auc(pos_scores, control_scores)
    return {
        "rows": rows,
        "positives": positives,
        "controls": controls,
        "positive": pos_summary,
        "control": control_summary,
        "auc": score_auc,
        "tprAtThreshold": pos_summary["hitRateGeThreshold"],
        "fprAtThreshold": control_summary["hitRateGeThreshold"],
    }


def choose_conclusion(*, model_label: str, enough_samples: bool, overlap_ok: bool, pos_summary: dict[str, float], control_summary: dict[str, float], auc_value: float, threshold_tpr: float) -> tuple[str, bool]:
    generalizes = (
        enough_samples
        and overlap_ok
        and threshold_tpr >= 0.60
        and pos_summary["median"] > max(0.20, control_summary["median"] + 0.20)
        and auc_value >= 0.75
    )
    near_low_prior = pos_summary["mean"] <= 0.12 and pos_summary["median"] <= 0.10
    if generalizes:
        return f"初步闭环：{model_label} 在零重叠独立集上表现出泛化判别力。", False
    if near_low_prior:
        return f"未闭环：{model_label} 在独立假脸正样本上仍贴近低先验，未证明泛化。", True
    return f"部分证据不足：{model_label} 没有达到命中率/AUC 闭环门槛，建议继续扩充 hard-negative 或人工强正样本后复测。", True


def load_ratio_lookup(path: Path | None) -> dict[float, dict[str, str]]:
    if path is None or not path.exists():
        return {}
    rows = read_csv(path)
    lookup: dict[float, dict[str, str]] = {}
    for row in rows:
        if str(row.get("selected", "")).strip().lower() != "true":
            continue
        ratio = to_float(row.get("ratio"), default=-1.0)
        if ratio < 0:
            continue
        lookup[ratio] = row
    return lookup


def build_summary_payload(
    *,
    threshold: float,
    raw: dict[str, Any],
    overlap_ok: bool,
    enough_samples: bool,
    conclusion: str,
    phase3_needed: bool,
    summary: dict[str, Any],
    comparison: dict[str, Any] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schemaVersion": "framecull-false-face-generalization-v13-summary-v2",
        "threshold": threshold,
        "activeEp": raw.get("activeEp"),
        "epFallbackChain": raw.get("epFallbackChain"),
        "backboneVersion": raw.get("backboneVersion"),
        "count": len(summary["rows"]),
        "positive": summary["positive"],
        "control": summary["control"],
        "auc": summary["auc"],
        "tprAtThreshold": summary["tprAtThreshold"],
        "fprAtThreshold": summary["fprAtThreshold"],
        "enoughSamples": enough_samples,
        "overlapOk": overlap_ok,
        "phase3Needed": phase3_needed,
        "conclusion": conclusion,
    }
    if comparison:
        payload["comparison"] = comparison
    return payload


def compare_runs(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, float]:
    return {
        "positiveMeanDelta": current["positive"]["mean"] - baseline["positive"]["mean"],
        "positiveMedianDelta": current["positive"]["median"] - baseline["positive"]["median"],
        "controlMeanDelta": current["control"]["mean"] - baseline["control"]["mean"],
        "aucDelta": current["auc"] - baseline["auc"],
        "tprDelta": current["tprAtThreshold"] - baseline["tprAtThreshold"],
        "fprDelta": current["fprAtThreshold"] - baseline["fprAtThreshold"],
    }


def tradeoff_delta(v12_ratio: Path | None, v13_ratio: Path | None, ratio_value: float = 0.45) -> dict[str, Any] | None:
    base_lookup = load_ratio_lookup(v12_ratio)
    current_lookup = load_ratio_lookup(v13_ratio)
    base = base_lookup.get(ratio_value)
    current = current_lookup.get(ratio_value)
    if not base or not current:
        return None
    base_recall = to_float(base.get("recall"), default=float("nan"))
    current_recall = to_float(current.get("recall"), default=float("nan"))
    base_negative = to_float(base.get("negativePickRate"), default=float("nan"))
    current_negative = to_float(current.get("negativePickRate"), default=float("nan"))
    return {
        "ratio": ratio_value,
        "v12Recall": base_recall,
        "v13Recall": current_recall,
        "recallDelta": current_recall - base_recall,
        "v12NegativePickRate": base_negative,
        "v13NegativePickRate": current_negative,
        "negativePickRateDelta": current_negative - base_negative,
        "recallDropWithin2pp": (current_recall - base_recall) >= -0.02,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--independent-set", required=True)
    parser.add_argument("--raw", required=True, help="Current run raw inference json")
    parser.add_argument("--overlap-check", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--model-label", default="v12 独立头")
    parser.add_argument("--scores-name", default="v12-generalization-scores.csv")
    parser.add_argument("--summary-name", default="v13-generalization-summary.json")
    parser.add_argument("--report-name", default="false-face-generalization-report.md")
    parser.add_argument("--raw-copy-name", default="")
    parser.add_argument("--baseline-raw", default="", help="Optional baseline raw inference json for v12 vs v13 comparison")
    parser.add_argument("--baseline-label", default="v12 独立头")
    parser.add_argument("--v12-ratio-metrics", default="", help="Optional selected metrics-by-ratio.csv for v12")
    parser.add_argument("--v13-ratio-metrics", default="", help="Optional selected metrics-by-ratio.csv for v13")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    independent_rows = read_csv(Path(args.independent_set))
    labels = label_map(independent_rows)
    raw = read_json(Path(args.raw))
    overlap = read_json(Path(args.overlap_check))
    rows = normalize_rows(labels, raw)
    current = summarize_rows(rows, args.threshold)

    enough_samples = (
        30 <= len(current["positives"]) <= 60
        and 20 <= len(current["controls"]) <= 30
    )
    overlap_ok = bool(overlap.get("independentSetZeroOverlapOk"))
    conclusion, phase3_needed = choose_conclusion(
        model_label=args.model_label,
        enough_samples=enough_samples,
        overlap_ok=overlap_ok,
        pos_summary=current["positive"],
        control_summary=current["control"],
        auc_value=current["auc"],
        threshold_tpr=current["tprAtThreshold"],
    )

    score_path = output_dir / args.scores_name
    write_scores_csv(score_path, rows)
    if args.raw_copy_name:
        (output_dir / args.raw_copy_name).write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    comparison_summary = None
    baseline_summary = None
    if args.baseline_raw:
        baseline_raw = read_json(Path(args.baseline_raw))
        baseline_rows = normalize_rows(labels, baseline_raw)
        baseline_summary = summarize_rows(baseline_rows, args.threshold)
        comparison_summary = compare_runs(baseline_summary, current)

    tradeoff = tradeoff_delta(
        Path(args.v12_ratio_metrics) if args.v12_ratio_metrics else None,
        Path(args.v13_ratio_metrics) if args.v13_ratio_metrics else None,
        ratio_value=0.45,
    )

    payload = build_summary_payload(
        threshold=args.threshold,
        raw=raw,
        overlap_ok=overlap_ok,
        enough_samples=enough_samples,
        conclusion=conclusion,
        phase3_needed=phase3_needed,
        summary=current,
        comparison={
            "baselineLabel": args.baseline_label,
            "currentLabel": args.model_label,
            "summary": comparison_summary,
            "tradeoff45": tradeoff,
        } if comparison_summary else None,
    )
    (output_dir / args.summary_name).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    misses = sorted(current["positives"], key=lambda row: float(row["falseFaceRisk"]))
    high_controls = sorted(current["controls"], key=lambda row: -float(row["falseFaceRisk"]))
    lines = [
        "# FrameCull False-Face Generalization Report",
        "",
        "## 结论",
        "",
        conclusion,
        "",
        f"当前主评估模型：`{args.model_label}`。",
    ]
    if comparison_summary:
        lines.extend(
            [
                f"对照基线：`{args.baseline_label}`。",
                "",
                "## v12 vs v13 独立集对比",
                "",
                f"- 正样本均值变化：`{signed_pct(comparison_summary['positiveMeanDelta'])}`（按 0-1 风险值的绝对差展示仅作参考）",
                f"- 正样本中位数变化：`{signed_pct(comparison_summary['positiveMedianDelta'])}`",
                f"- 对照组均值变化：`{signed_pct(comparison_summary['controlMeanDelta'])}`",
                f"- AUC 变化：`{comparison_summary['aucDelta']:+.4f}`",
                f"- TPR 变化：`{signed_pct(comparison_summary['tprDelta'])}`",
                f"- FPR 变化：`{signed_pct(comparison_summary['fprDelta'])}`",
            ]
        )
        if tradeoff:
            lines.extend(
                [
                    "",
                    "## @45% 召回 trade-off",
                    "",
                    f"- v12 recall：`{pct(tradeoff['v12Recall'])}`",
                    f"- v13 recall：`{pct(tradeoff['v13Recall'])}`",
                    f"- recall delta：`{signed_pct(tradeoff['recallDelta'])}`",
                    f"- recall 回退是否 < 2pp：`{bool(tradeoff['recallDropWithin2pp'])}`",
                    f"- v12 negative pick rate：`{pct(tradeoff['v12NegativePickRate'])}`",
                    f"- v13 negative pick rate：`{pct(tradeoff['v13NegativePickRate'])}`",
                    f"- negative pick delta：`{signed_pct(tradeoff['negativePickRateDelta'])}`",
                ]
            )
    else:
        lines.append("本轮没有提供 baseline 对照，因此这里只写单次独立集结论。")

    lines.extend(
        [
            "",
            "## 独立集与零重叠校验",
            "",
            f"- 独立集总数：`{len(current['rows'])}`",
            f"- 真·假脸正样本：`{len(current['positives'])}`",
            f"- 真·有脸对照：`{len(current['controls'])}`",
            f"- 与训练全集交集：`{overlap.get('independentSetOverlapCount', 'n/a')}`",
            f"- 零重叠校验：`{overlap_ok}`",
            f"- 训练全集 teacher 记录数：`{overlap.get('teacherRecordCount', 'n/a')}`",
            "",
            "说明：独立集标签来自人工视觉确认，CSV 中记录了 `hasRealHumanFace`、`sampleRole`、`scene` 和 `illusionReason`。没有使用 teacher 自标或合成样本作为 ground truth。",
            "",
            f"## {args.model_label} 独立集分布",
            "",
            "| Group | Count | Mean | Median | P25 | P75 | Max | >=0.5 |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
            (
                f"| false_face_positive | {len(current['positives'])} | {fmt(current['positive']['mean'])} | "
                f"{fmt(current['positive']['median'])} | {fmt(current['positive']['p25'])} | {fmt(current['positive']['p75'])} | "
                f"{fmt(current['positive']['max'])} | {current['positive']['hitRateGeThreshold']:.2%} |"
            ),
            (
                f"| real_face_control | {len(current['controls'])} | {fmt(current['control']['mean'])} | "
                f"{fmt(current['control']['median'])} | {fmt(current['control']['p25'])} | {fmt(current['control']['p75'])} | "
                f"{fmt(current['control']['max'])} | {current['control']['hitRateGeThreshold']:.2%} |"
            ),
            "",
            "## 可分性",
            "",
            f"- 阈值：`falseFaceRisk >= {args.threshold}`",
            f"- TPR：`{current['tprAtThreshold']:.2%}`",
            f"- FPR：`{current['fprAtThreshold']:.2%}`",
            f"- AUC：`{current['auc']:.4f}`",
            f"- 推理 EP：`{raw.get('activeEp')}`",
            f"- Backbone：`{raw.get('backboneVersion')}`",
            "",
            "## 仍然漏判的假脸样本",
            "",
            "| Photo | Scene | Risk | Reason |",
            "|---|---|---:|---|",
        ]
    )
    for row in misses[:12]:
        lines.append(
            f"| `{row['photoId']}` | `{row['manualScene']}` | {fmt(float(row['falseFaceRisk']))} | {row['illusionReason']} |"
        )
    lines.extend(
        [
            "",
            "## 对照组高风险样本",
            "",
            "| Photo | Scene | Risk | Notes |",
            "|---|---|---:|---|",
        ]
    )
    for row in high_controls[:10]:
        lines.append(
            f"| `{row['photoId']}` | `{row['manualScene']}` | {fmt(float(row['falseFaceRisk']))} | {row['illusionReason']} |"
        )

    lines.extend(
        [
            "",
            "## 判定",
            "",
            (
                "需要继续 Phase 3 / 保持 Phase 3：当前独立集证据仍不足以证明闭环。"
                if phase3_needed
                else "当前独立集证据已达到初步闭环门槛。"
            ),
            "",
            "## 产物",
            "",
            "- `independent-false-face-set.csv`",
            "- `overlap-check.json`",
            f"- `{args.scores_name}`",
            f"- `{args.summary_name}`",
            f"- `{args.report_name}`",
        ]
    )
    if args.raw_copy_name:
        lines.append(f"- `{args.raw_copy_name}`")
    if comparison_summary:
        lines.append(f"- baseline raw: `{Path(args.baseline_raw).name}`")

    (output_dir / args.report_name).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
