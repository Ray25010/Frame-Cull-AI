#!/usr/bin/env python3
"""Write the final v15B false-face route-B report."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


LAB = Path("/data/FrameCullModelLab")
DEFAULT_OUT = LAB / "outputs/semantic-false-face-diagnosis/v15b"
DEFAULT_V13 = LAB / "outputs/semantic-false-face-diagnosis/v13-eval"
DEFAULT_V14 = LAB / "outputs/semantic-false-face-diagnosis/v14"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--v13-dir", type=Path, default=DEFAULT_V13)
    parser.add_argument("--v14-dir", type=Path, default=DEFAULT_V14)
    args = parser.parse_args()

    out = args.out
    v12 = read_json(args.v13_dir / "v12-generalization-summary.json")
    v13 = read_json(args.v13_dir / "v13-generalization-summary.json")
    v14 = read_json(args.v14_dir / "v14-generalization-summary.json")
    v15 = read_json(args.v13_dir / "face-presence-eval-v15.json")
    v15b_holdout = read_json(out / "holdout-summary-v15b.json")
    manifest = read_json(out / "crop-dataset-manifest.json")
    training = read_json(out / "training-report-v15b.json")
    coverage = read_json(out / "upstream-gate-v2-coverage.json")
    replay = read_json(out / "replay-summary.json")
    ratio_rows = read_csv(out / "metrics-by-ratio.csv")

    historical_rows = [
        metric_row("v12 semantic student independent head", v12),
        metric_row("v13 expanded hard-negative student", v13),
        metric_row("v14 semantic student region supervision", v14),
        metric_row("v15 YuNet cross-check", v15["metrics"]["selectedV15Risk"]),
        metric_row("v15B independent crop classifier", v15b_holdout["metrics"]),
    ]
    row45_exclude = find_ratio(ratio_rows, "0.45", "exclude")
    row45_downweight = find_ratio(ratio_rows, "0.45", "downweight")
    verdict = final_verdict(v15b_holdout["metrics"], row45_exclude, row45_downweight)
    final_summary = {
        "schemaVersion": "framecull-false-face-v15b-final-summary-v1",
        "verdict": verdict,
        "holdout": {
            "usedForTrainingTuningOrThresholdFitting": False,
            "metrics": v15b_holdout["metrics"],
        },
        "training": {
            "bestValAuc": training["training"]["bestValAuc"],
            "bestEpoch": training["training"]["bestEpoch"],
            "modelName": training["model"]["modelName"],
            "pretrained": training["model"]["pretrained"],
        },
        "dataset": {
            "holdoutIntersectionCount": manifest["holdoutIntersectionCount"],
            "labelCounts": manifest["labelCounts"],
            "totalUsableCropSamples": manifest["totalUsableCropSamples"],
        },
        "coverage": coverage,
        "replayAt45": {
            "excludeRecallDropPp": float(row45_exclude["recallDropPp"]),
            "downweightRecallDropPp": float(row45_downweight["recallDropPp"]),
            "autoExcludeAllowedByRecallGate": float(row45_exclude["recallDropPp"]) < 2.0,
            "autoDownweightAllowedByRecallGate": float(row45_downweight["recallDropPp"]) < 2.0,
        },
        "note": "This v15B summary supersedes the generic replay-summary.json wording, which is produced by the reused v15 replay script.",
    }
    (out / "v15b-final-summary.json").write_text(json.dumps(final_summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# FrameCull False Face v15B Crop Classifier Report",
        "",
        "## Final Verdict",
        "",
        f"- 判定：**{verdict['label']}**",
        f"- 原因：{verdict['reason']}",
        "- 本轮没有并回 semantic student，没有改 backbone/teacher prompt；84 张 holdout 未进入训练、调参或阈值拟合。",
        "",
        "## Crop Dataset",
        "",
        f"- Teacher records: `{manifest['totalTeacherRecordsRead']}`",
        f"- Usable crop samples: `{manifest['totalUsableCropSamples']}`",
        f"- Label counts: `{manifest['labelCounts']}`",
        f"- Dataset counts: `{manifest['datasetCounts']}`",
        f"- Holdout intersection: `{manifest['holdoutIntersectionCount']}`",
        "",
        "## Training",
        "",
        f"- Model: `{training['model']['modelName']}`",
        f"- Pretrained: `{training['model']['pretrained']}`",
        f"- Device: `{training['model']['device']}`",
        f"- Best validation AUC: `{training['training']['bestValAuc']:.4f}` at epoch `{training['training']['bestEpoch']}`",
        f"- Elapsed: `{training['training']['elapsedS']:.1f}s`",
        "",
        "## 84 Holdout Comparable Metrics",
        "",
        "| Version | AUC | TPR@0.5 | FPR@0.5 | Count |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for row in historical_rows:
        lines.append(
            f"| {row['name']} | {row['auc']:.4f} | {row['tpr']:.4f} | {row['fpr']:.4f} | {row['count']} |"
        )
    lines += [
        "",
        "Gate targets:",
        f"- AUC target: `>= 0.75`; v15B = `{historical_rows[-1]['auc']:.4f}`.",
        f"- FPR target: clearly `< 36.7%`, ideally `< 15%`; v15B = `{historical_rows[-1]['fpr'] * 100:.2f}%`.",
        f"- TPR@0.5 non-zero; v15B = `{historical_rows[-1]['tpr'] * 100:.2f}%`.",
        "",
        "## Full 7692 Gate Coverage",
        "",
        f"- v15 upstream gate: `{coverage['v15Reference']['upstreamGateTriggered']}` / `{coverage['v15b']['total']}` = `{coverage['v15Reference']['upstreamGateTriggerRate'] * 100:.2f}%`",
        f"- v15B upstream gate: `{coverage['v15b']['upstreamGateTriggered']}` / `{coverage['v15b']['total']}` = `{coverage['v15b']['upstreamGateTriggerRate'] * 100:.2f}%`",
        f"- v15 final guard trigger rate: `{coverage['v15Reference']['guardTriggerRate'] * 100:.2f}%`",
        f"- v15B final guard trigger rate: `{coverage['v15b']['guardTriggerRate'] * 100:.2f}%`",
        f"- v15B teacher-proxy real-face hits: `{coverage['v15b']['teacherProxyGuardRealFaceCount']}`",
        f"- v15B teacher-proxy high-risk false-face hits: `{coverage['v15b']['teacherProxyGuardFalseFaceHighRiskCount']}`",
        "",
        "## Full Replay Recall Tradeoff",
        "",
        "| Ratio | Variant | Recall | Recall Drop | Negative Pick Rate | Guard Hits In Picks |",
        "| ---: | --- | ---: | ---: | ---: | ---: |",
    ]
    for row in ratio_rows:
        lines.append(
            f"| {float(row['ratio']) * 100:.0f}% | {row['variant']} | {pct(row['recall'])} | {pp(row['recallDropPp'])} | {pct(row['negativePickRate'])} | {row['pickedGuardTriggered']} |"
        )
    lines += [
        "",
        "## @45 Decision",
        "",
        f"- Auto exclude recall drop: `{row45_exclude['recallDropPp']}pp`",
        f"- Downweight recall drop: `{row45_downweight['recallDropPp']}pp`",
        f"- Required gate: `< 2pp`; result: **failed**.",
        "",
        "## Honest Conclusion",
        "",
        "- Route B 的方向是对的：独立 crop 判别器确实和 semantic student 解耦，也把上游 gate 从 99.6% 收窄到 72.8%。",
        "- 但这版从零训练的 MobileNetV3 crop classifier 泛化失败：84 holdout AUC 低于随机方向，FPR 反而升到 80%。",
        "- 全量 replay 中自动剔除和降权都造成明显召回回退，不能进入自动拦截，也不能作为生产默认策略。",
        "- 下一步如果继续路线 B，应换成有强预训练的 crop backbone 或 DINO/CLIP crop-feature teacher，再做轻量 student，而不是继续在这版随机初始化小模型上堆 epoch。",
        "",
        "## Artifacts",
        "",
        f"- `{out / 'crop-dataset-manifest.json'}`",
        f"- `{out / 'training-report-v15b.json'}`",
        f"- `{out / 'upstream-gate-v2-coverage.json'}`",
        f"- `{out / 'v15b-holdout-scores.csv'}`",
        f"- `{out / 'metrics-by-ratio.csv'}`",
        f"- `{out / 'false-injury-top.csv'}`",
        f"- `{out / 'v15b-final-summary.json'}`",
        f"- `{out / 'false-face-v15b-report.md'}`",
    ]
    (out / "false-face-v15b-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"wrote": str(out / "false-face-v15b-report.md"), "verdict": verdict}, ensure_ascii=False, indent=2))


def metric_row(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": name,
        "auc": float(payload.get("auc", 0.0)),
        "tpr": float(payload.get("tprAtThreshold", 0.0)),
        "fpr": float(payload.get("fprAtThreshold", 0.0)),
        "count": int(payload.get("count", 0)),
    }


def final_verdict(holdout_metrics: dict[str, Any], row45_exclude: dict[str, str], row45_downweight: dict[str, str]) -> dict[str, str]:
    auc = float(holdout_metrics["auc"])
    fpr = float(holdout_metrics["fprAtThreshold"])
    tpr = float(holdout_metrics["tprAtThreshold"])
    exclude_drop = float(row45_exclude["recallDropPp"])
    downweight_drop = float(row45_downweight["recallDropPp"])
    if auc >= 0.75 and fpr < 0.367 and tpr > 0 and exclude_drop < 2 and downweight_drop < 2:
        return {"label": "eligible-for-controlled-auto-guard", "reason": "holdout and full replay gates passed."}
    return {
        "label": "guard-only / failed",
        "reason": (
            f"holdout AUC={auc:.4f}, FPR={fpr * 100:.2f}%, TPR={tpr * 100:.2f}%; "
            f"@45 exclude drop={exclude_drop:.2f}pp, downweight drop={downweight_drop:.2f}pp."
        ),
    }


def find_ratio(rows: list[dict[str, str]], ratio: str, variant: str) -> dict[str, str]:
    for row in rows:
        if row.get("ratio") == ratio and row.get("variant") == variant:
            return row
    raise KeyError(f"missing ratio={ratio} variant={variant}")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def pct(value: str | float) -> str:
    return f"{float(value) * 100:.2f}%"


def pp(value: str | float) -> str:
    return f"{float(value):.2f}pp"


if __name__ == "__main__":
    main()
