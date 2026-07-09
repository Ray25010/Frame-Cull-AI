#!/usr/bin/env python
"""Plan Phase 3 v13 hard-negative retraining without contaminating holdout."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--independent-set", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    independent = read_csv(Path(args.independent_set))
    holdout_ids = {row["photoId"].lower() for row in independent}
    false_positive_holdout = [row for row in independent if row["sampleRole"] == "false_face_positive"]
    control_holdout = [row for row in independent if row["sampleRole"] == "real_face_control"]

    payload = {
        "schemaVersion": "framecull-false-face-v13-retrain-plan-v1",
        "status": "phase2_failed_retrain_required",
        "holdoutPolicy": "All independent validation photoIds remain excluded from v13 training and teacher augmentation.",
        "holdoutCount": len(holdout_ids),
        "falseFaceHoldoutCount": len(false_positive_holdout),
        "realFaceControlHoldoutCount": len(control_holdout),
        "v13TrainingRequirement": {
            "goal": "increase hard-negative training examples from 2 to at least dozens or hundreds",
            "studentOnly": True,
            "keepBackbone": "convnext_tiny",
            "keepTeacherPrompt": True,
            "mustNotUseHoldoutIds": sorted(holdout_ids),
            "mustRetest": [
                "v12 vs v13 on the same independent holdout",
                "AI pick recall trade-off at 45%; recall drop must be <2pp if retrained",
            ],
        },
        "recommendedNextStep": (
            "Use additional non-holdout images from the same external candidate pool or other training sources, "
            "manually label true false-face hard negatives, merge them into the semantic teacher training JSONL, "
            "then retrain only the student and re-run this v13-eval holdout."
        ),
    }
    (output_dir / "v13-retrain-plan.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    with (output_dir / "v13-holdout-photoids.txt").open("w", encoding="utf-8") as handle:
        for photo_id in sorted(holdout_ids):
            handle.write(photo_id + "\n")

    print(json.dumps({
        "holdoutCount": len(holdout_ids),
        "falseFaceHoldoutCount": len(false_positive_holdout),
        "realFaceControlHoldoutCount": len(control_holdout),
        "outputDir": str(output_dir),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
