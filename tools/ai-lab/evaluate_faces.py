from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

try:
    import supervision as sv
except Exception:  # pragma: no cover - fallback keeps the tool usable without supervision.
    sv = None


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}


@dataclass
class Box:
    xyxy: tuple[float, float, float, float]
    confidence: float = 1.0
    label: str = "face"


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate FrameCull AI face detection outputs.")
    parser.add_argument("--images", required=True, type=Path, help="Directory containing source photos.")
    parser.add_argument("--predictions", required=True, type=Path, help="JSON predictions keyed by file name.")
    parser.add_argument("--annotations", required=True, type=Path, help="JSON annotations keyed by file name.")
    parser.add_argument("--out", required=True, type=Path, help="Output directory for marked images and summary.json.")
    parser.add_argument("--iou", default=0.5, type=float, help="IoU threshold for a matched face.")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    predictions = load_box_map(args.predictions)
    annotations = load_box_map(args.annotations)
    image_paths = [path for path in args.images.rglob("*") if path.suffix.lower() in IMAGE_EXTENSIONS]

    totals = {"images": 0, "tp": 0, "fp": 0, "fn": 0}
    per_image: dict[str, dict[str, Any]] = {}

    for image_path in image_paths:
        key = image_path.name
        pred_boxes = predictions.get(key, [])
        gt_boxes = annotations.get(key, [])
        result = match_boxes(pred_boxes, gt_boxes, args.iou)
        totals["images"] += 1
        totals["tp"] += len(result["matches"])
        totals["fp"] += len(result["false_positives"])
        totals["fn"] += len(result["false_negatives"])
        per_image[key] = {
            "tp": len(result["matches"]),
            "fp": len(result["false_positives"]),
            "fn": len(result["false_negatives"]),
            "matches": result["matches"],
        }
        write_diagnostic_image(image_path, args.out / image_path.name, pred_boxes, gt_boxes, result)

    precision = safe_div(totals["tp"], totals["tp"] + totals["fp"])
    recall = safe_div(totals["tp"], totals["tp"] + totals["fn"])
    summary = {
        **totals,
        "precision": precision,
        "recall": recall,
        "f1": safe_div(2 * precision * recall, precision + recall),
        "per_image": per_image,
    }
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ["images", "tp", "fp", "fn", "precision", "recall", "f1"]}, indent=2))


def load_box_map(path: Path) -> dict[str, list[Box]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        name: [parse_box(item) for item in items]
        for name, items in raw.items()
    }


def parse_box(item: dict[str, Any]) -> Box:
    xyxy = item.get("xyxy")
    if not isinstance(xyxy, list) or len(xyxy) != 4:
        raise ValueError(f"Box must contain xyxy=[x1,y1,x2,y2], got {item!r}")
    return Box(
        xyxy=tuple(float(value) for value in xyxy),
        confidence=float(item.get("confidence", 1.0)),
        label=str(item.get("label", "face")),
    )


def match_boxes(predictions: list[Box], annotations: list[Box], iou_threshold: float) -> dict[str, Any]:
    used_gt: set[int] = set()
    matches: list[dict[str, Any]] = []
    false_positives: list[int] = []

    for pred_index, pred in sorted(enumerate(predictions), key=lambda item: item[1].confidence, reverse=True):
        best_gt = -1
        best_iou = 0.0
        for gt_index, gt in enumerate(annotations):
            if gt_index in used_gt:
                continue
            score = iou(pred.xyxy, gt.xyxy)
            if score > best_iou:
                best_iou = score
                best_gt = gt_index
        if best_gt >= 0 and best_iou >= iou_threshold:
            used_gt.add(best_gt)
            matches.append({"prediction": pred_index, "annotation": best_gt, "iou": best_iou})
        else:
            false_positives.append(pred_index)

    false_negatives = [index for index in range(len(annotations)) if index not in used_gt]
    return {
        "matches": matches,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
    }


def write_diagnostic_image(
    image_path: Path,
    output_path: Path,
    predictions: list[Box],
    annotations: list[Box],
    result: dict[str, Any],
) -> None:
    image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if sv is not None:
        image = annotate_with_supervision(image, predictions, annotations, result)
    else:
        image = annotate_with_cv2(image, predictions, annotations, result)
    cv2.imencode(output_path.suffix or ".jpg", image)[1].tofile(str(output_path))


def annotate_with_supervision(image: np.ndarray, predictions: list[Box], annotations: list[Box], result: dict[str, Any]) -> np.ndarray:
    matched_pred = {match["prediction"] for match in result["matches"]}
    false_pos = set(result["false_positives"])
    false_neg = set(result["false_negatives"])
    for index, box in enumerate(predictions):
        color = (70, 200, 90) if index in matched_pred else (40, 40, 230)
        draw_box(image, box.xyxy, color, f"P {box.confidence:.2f}")
    for index, box in enumerate(annotations):
        if index in false_neg:
            draw_box(image, box.xyxy, (0, 190, 255), "MISS")
    return image


def annotate_with_cv2(image: np.ndarray, predictions: list[Box], annotations: list[Box], result: dict[str, Any]) -> np.ndarray:
    return annotate_with_supervision(image, predictions, annotations, result)


def draw_box(image: np.ndarray, xyxy: tuple[float, float, float, float], color: tuple[int, int, int], label: str) -> None:
    x1, y1, x2, y2 = [int(round(value)) for value in xyxy]
    cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
    cv2.putText(image, label, (x1, max(14, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    intersection = max(0.0, inter_x2 - inter_x1) * max(0.0, inter_y2 - inter_y1)
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - intersection
    return 0.0 if union <= 0 else intersection / union


def safe_div(numerator: float, denominator: float) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


if __name__ == "__main__":
    main()
