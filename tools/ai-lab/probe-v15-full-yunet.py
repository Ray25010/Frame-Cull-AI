from __future__ import annotations

import argparse
import csv
import json
import math
import time
from pathlib import Path
from typing import Any

import cv2


DEFAULT_BASE = Path(
    "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/"
    "bench-grounded-v14-five-mountain-region"
)
DEFAULT_INFER = DEFAULT_BASE / "pro-infer-latency.json"
DEFAULT_TEACHER = Path(
    "/data/FrameCullModelLab/features/semantic-teacher/"
    "semantic-teacher-v1.3-five-mountain-v14.jsonl"
)
DEFAULT_MODEL = Path("/data/FrameCullModelLab/workspace-current/face_detection_yunet_2023mar.onnx")
DEFAULT_OUTPUT = Path("/data/FrameCullModelLab/outputs/semantic-false-face-diagnosis/v15-replay")

LOW_PROPOSAL_THRESHOLD = 0.08
GUARD_THRESHOLD = 0.5


def main() -> None:
    parser = argparse.ArgumentParser(description="FrameCull v15 full-set YuNet guard probe")
    parser.add_argument("--infer", type=Path, default=DEFAULT_INFER)
    parser.add_argument("--teacher", type=Path, default=DEFAULT_TEACHER)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--every", type=int, default=250)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    if not args.model.exists():
        raise FileNotFoundError(f"YuNet model not found: {args.model}")

    infer = json.loads(args.infer.read_text(encoding="utf-8"))
    rows = infer.get("results") or []
    if args.limit > 0:
        rows = rows[: args.limit]

    teacher_by_path = load_teacher_by_path(args.teacher)
    detector = cv2.FaceDetectorYN_create(
        str(args.model),
        "",
        (640, 640),
        score_threshold=LOW_PROPOSAL_THRESHOLD,
        nms_threshold=0.3,
        top_k=5000,
    )

    started = time.time()
    results: list[dict[str, Any]] = []
    errors = 0
    for index, row in enumerate(rows, start=1):
        image_path = Path(row.get("imagePath") or "")
        item_started = time.time()
        try:
            result = score_image(detector, image_path)
        except Exception as exc:  # noqa: BLE001 - lab probe must keep going.
            errors += 1
            result = {
                "width": 0,
                "height": 0,
                "maxFacePresence": 0.0,
                "reliableFacePresence": 0.0,
                "faceCount": 0,
                "reliableFaceCount": 0,
                "enhancedPasses": 0,
                "boxes": [],
                "error": str(exc),
            }
        elapsed_ms = (time.time() - item_started) * 1000
        teacher = teacher_by_path.get(normalize_path(str(image_path))) or {}
        max_face = clamp01(result["maxFacePresence"])
        reliable = clamp01(result["reliableFacePresence"])
        selected_risk = clamp01(1.0 - reliable)
        low_proposal = max_face >= LOW_PROPOSAL_THRESHOLD
        conflict_risk = selected_risk if low_proposal else 0.0
        guard_triggered = conflict_risk >= GUARD_THRESHOLD
        teacher_false_face_risk = num(teacher.get("falseFaceRisk"))
        teacher_has_real_face = teacher.get("hasRealHumanFace")
        teacher_face_relevant = bool(teacher_has_real_face is True or teacher_false_face_risk >= GUARD_THRESHOLD)
        results.append(
            {
                "photoId": row.get("photoId"),
                "imagePath": str(image_path),
                "dataset": teacher.get("dataset") or infer_dataset(str(image_path)),
                "proSceneLabel": row.get("sceneLabel"),
                "proSceneConfidence": num(row.get("sceneConfidence")),
                "proFaceValidityScore": num(row.get("faceValidityScore")),
                "proFalseFaceRisk": num(row.get("falseFaceRisk")),
                "teacherSceneType": teacher.get("sceneType"),
                "teacherSubjectType": teacher.get("subjectType"),
                "teacherHasRealHumanFace": teacher_has_real_face,
                "teacherFalseFaceRisk": teacher_false_face_risk,
                "teacherFaceRelevant": teacher_face_relevant,
                "width": result["width"],
                "height": result["height"],
                "maxFacePresence": max_face,
                "reliableFacePresence": reliable,
                "faceCount": int(result["faceCount"]),
                "reliableFaceCount": int(result["reliableFaceCount"]),
                "enhancedPasses": int(result["enhancedPasses"]),
                "selectedV15Risk": selected_risk,
                "lowThresholdProposal": low_proposal,
                "conflictRisk": clamp01(conflict_risk),
                "softConflictRisk": clamp01(math.sqrt(max(0.0, max_face) * max(0.0, 1.0 - reliable))),
                "upstreamGateTriggered": low_proposal,
                "guardTriggered": guard_triggered,
                "elapsedMs": elapsed_ms,
                "boxes": result["boxes"][:8],
                "error": result.get("error") or None,
            }
        )
        if args.every > 0 and (index % args.every == 0 or index == len(rows)):
            print(f"[v15-yunet] {index}/{len(rows)} errors={errors} elapsed={(time.time() - started):.1f}s", flush=True)

    payload = {
        "schemaVersion": "framecull-v15-full-yunet-guard-scores-v1",
        "createdAt": iso_now(),
        "inferPath": str(args.infer),
        "teacherPath": str(args.teacher),
        "modelPath": str(args.model),
        "lowProposalThreshold": LOW_PROPOSAL_THRESHOLD,
        "guardThreshold": GUARD_THRESHOLD,
        "runtime": {
            "opencvVersion": cv2.__version__,
            "backend": "opencv.FaceDetectorYN",
            "enhancedRegions": True,
        },
        "count": len(results),
        "elapsedMs": (time.time() - started) * 1000,
        "errors": errors,
        "summary": summarize(results),
        "results": results,
    }
    json_path = args.output / "guard-full-scores.json"
    csv_path = args.output / "guard-full-scores.csv"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(csv_path, results)
    print(json.dumps({"json": str(json_path), "csv": str(csv_path), "summary": payload["summary"]}, ensure_ascii=False, indent=2))


def load_teacher_by_path(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    out: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            image_path = row.get("studentPreviewPath") or row.get("imagePath")
            if image_path:
                out[normalize_path(str(image_path))] = row
    return out


def score_image(detector: Any, image_path: Path) -> dict[str, Any]:
    image = cv2.imread(str(image_path))
    if image is None:
        raise FileNotFoundError(str(image_path))
    height, width = image.shape[:2]
    boxes = detect_candidates(detector, image, "full")
    enhanced_passes = 0
    if should_run_enhanced(boxes, width, height):
        for region in enhanced_regions(width, height):
            x, y, w, h, source = region
            crop = image[y : y + h, x : x + w]
            if crop.size == 0:
                continue
            enhanced_passes += 1
            for box in detect_candidates(detector, crop, source):
                box = dict(box)
                box["x"] += x
                box["y"] += y
                box["keypoints"] = [{"x": point["x"] + x, "y": point["y"] + y} for point in box.get("keypoints", [])]
                boxes.append(clamp_box(box, width, height))
    merged = merge_boxes(boxes, 0.35)
    reliable = filter_reliable(merged, width, height)
    return {
        "width": width,
        "height": height,
        "maxFacePresence": max_confidence(merged),
        "reliableFacePresence": max_confidence(reliable),
        "faceCount": len(merged),
        "reliableFaceCount": len(reliable),
        "enhancedPasses": enhanced_passes,
        "boxes": [round_box(box) for box in reliable[:8]],
    }


def detect_candidates(detector: Any, image: Any, source: str) -> list[dict[str, Any]]:
    height, width = image.shape[:2]
    prepared, scale, offset_x, offset_y = prepare_yunet_input(image)
    detector.setInputSize((640, 640))
    _, faces = detector.detect(prepared)
    if faces is None:
        return []
    boxes = []
    for raw in faces:
        x, y, w, h = [float(value) for value in raw[:4]]
        mapped_x = (x - offset_x) / max(scale, 1e-6)
        mapped_y = (y - offset_y) / max(scale, 1e-6)
        mapped_w = w / max(scale, 1e-6)
        mapped_h = h / max(scale, 1e-6)
        keypoints = []
        for i in range(4, 14, 2):
            keypoints.append({
                "x": (float(raw[i]) - offset_x) / max(scale, 1e-6),
                "y": (float(raw[i + 1]) - offset_y) / max(scale, 1e-6),
            })
        confidence = float(raw[14])
        boxes.append(
            clamp_box(
                {
                    "x": mapped_x,
                    "y": mapped_y,
                    "width": mapped_w,
                    "height": mapped_h,
                    "confidence": confidence,
                    "source": source,
                    "keypoints": keypoints,
                },
                width,
                height,
            )
        )
    return boxes


def prepare_yunet_input(image: Any) -> tuple[Any, float, int, int]:
    height, width = image.shape[:2]
    input_size = 640
    scale = min(input_size / max(1, width), input_size / max(1, height))
    draw_w = max(1, round(width * scale))
    draw_h = max(1, round(height * scale))
    offset_x = round((input_size - draw_w) / 2)
    offset_y = round((input_size - draw_h) / 2)
    canvas = cv2.copyMakeBorder(
        cv2.resize(image, (draw_w, draw_h), interpolation=cv2.INTER_LINEAR),
        offset_y,
        input_size - draw_h - offset_y,
        offset_x,
        input_size - draw_w - offset_x,
        cv2.BORDER_CONSTANT,
        value=(0, 0, 0),
    )
    return canvas, scale, offset_x, offset_y


def should_run_enhanced(boxes: list[dict[str, Any]], width: int, height: int) -> bool:
    if not boxes:
        return True
    short_edge = max(1, min(width, height))
    return max(box["height"] for box in boxes) < short_edge * 0.07


def enhanced_regions(width: int, height: int) -> list[tuple[int, int, int, int, str]]:
    tile_w = max(1, round(width * 0.62))
    tile_h = max(1, round(height * 0.62))
    regions: list[tuple[int, int, int, int, str]] = []
    for x in [0, max(0, width - tile_w)]:
        for y in [0, max(0, height - tile_h)]:
            regions.append((x, y, tile_w, tile_h, "tile"))
    center_w = max(1, round(width * 0.72))
    center_h = max(1, round(height * 0.72))
    regions.append((max(0, round((width - center_w) / 2)), max(0, round((height - center_h) / 2)), center_w, center_h, "center"))
    seen = set()
    unique = []
    for region in regions:
        key = region[:4]
        if key in seen:
            continue
        seen.add(key)
        unique.append(region)
    return unique


def merge_boxes(boxes: list[dict[str, Any]], iou_threshold: float) -> list[dict[str, Any]]:
    sorted_boxes = sorted([box for box in boxes if box["width"] > 0 and box["height"] > 0], key=lambda item: item["confidence"], reverse=True)
    merged: list[dict[str, Any]] = []
    for box in sorted_boxes:
        if any(iou(existing, box) > iou_threshold for existing in merged):
            continue
        merged.append(box)
    return sorted(merged, key=lambda item: item["width"] * item["height"], reverse=True)


def iou(a: dict[str, Any], b: dict[str, Any]) -> float:
    left = max(a["x"], b["x"])
    top = max(a["y"], b["y"])
    right = min(a["x"] + a["width"], b["x"] + b["width"])
    bottom = min(a["y"] + a["height"], b["y"] + b["height"])
    inter = max(0.0, right - left) * max(0.0, bottom - top)
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def filter_reliable(boxes: list[dict[str, Any]], width: int, height: int) -> list[dict[str, Any]]:
    image_area = max(1, width * height)
    reliable = []
    for box in boxes:
        confidence_floor = 0.34 if box["source"] == "full" else 0.38
        aspect = box["width"] / max(1.0, box["height"])
        area_ratio = (box["width"] * box["height"]) / image_area
        height_ratio = box["height"] / max(1.0, height)
        if (
            box["confidence"] >= confidence_floor
            and 0.42 <= aspect <= 1.85
            and area_ratio <= 0.24
            and height_ratio <= 0.62
            and box["width"] >= 14
            and box["height"] >= 14
            and plausible_keypoints(box)
        ):
            reliable.append(box)
    return sorted(reliable, key=lambda item: item["confidence"], reverse=True)


def plausible_keypoints(box: dict[str, Any]) -> bool:
    points = box.get("keypoints") or []
    if len(points) < 5:
        return True
    right_eye, left_eye, nose, right_mouth, left_mouth = points[:5]
    inside = sum(
        1
        for point in points
        if (
            box["x"] - box["width"] * 0.08 <= point["x"] <= box["x"] + box["width"] * 1.08
            and box["y"] - box["height"] * 0.08 <= point["y"] <= box["y"] + box["height"] * 1.08
        )
    )
    if inside < 4:
        return False
    eye_distance = math.hypot(left_eye["x"] - right_eye["x"], left_eye["y"] - right_eye["y"])
    mouth_distance = math.hypot(left_mouth["x"] - right_mouth["x"], left_mouth["y"] - right_mouth["y"])
    eye_ratio = eye_distance / max(1.0, box["width"])
    mouth_ratio = mouth_distance / max(1.0, box["width"])
    eye_y = (left_eye["y"] + right_eye["y"]) / 2
    mouth_y = (left_mouth["y"] + right_mouth["y"]) / 2
    nose_y_ratio = (nose["y"] - box["y"]) / max(1.0, box["height"])
    return (
        0.18 <= eye_ratio <= 0.72
        and 0.12 <= mouth_ratio <= 0.72
        and 0.2 <= nose_y_ratio <= 0.78
        and eye_y < mouth_y
        and nose["y"] > eye_y - box["height"] * 0.08
        and nose["y"] < mouth_y + box["height"] * 0.18
    )


def clamp_box(box: dict[str, Any], width: int, height: int) -> dict[str, Any]:
    x = max(0.0, min(float(width - 1), float(box["x"])))
    y = max(0.0, min(float(height - 1), float(box["y"])))
    w = max(1.0, min(float(width) - x, float(box["width"])))
    h = max(1.0, min(float(height) - y, float(box["height"])))
    out = dict(box)
    out.update({"x": x, "y": y, "width": w, "height": h})
    return out


def max_confidence(boxes: list[dict[str, Any]]) -> float:
    return max((float(box["confidence"]) for box in boxes), default=0.0)


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    gate = [row for row in results if row["upstreamGateTriggered"]]
    guard = [row for row in results if row["guardTriggered"]]
    teacher_known = [row for row in results if isinstance(row.get("teacherHasRealHumanFace"), bool)]
    teacher_relevant = [row for row in teacher_known if row["teacherFaceRelevant"]]
    gate_teacher = [row for row in gate if isinstance(row.get("teacherHasRealHumanFace"), bool)]
    guard_real_face = [row for row in guard if row.get("teacherHasRealHumanFace") is True]
    guard_false_face = [
        row
        for row in guard
        if row.get("teacherHasRealHumanFace") is False and num(row.get("teacherFalseFaceRisk")) >= GUARD_THRESHOLD
    ]
    return {
        "total": total,
        "errors": sum(1 for row in results if row.get("error")),
        "upstreamGateTriggered": len(gate),
        "upstreamGateTriggerRate": safe_div(len(gate), total),
        "guardTriggered": len(guard),
        "guardTriggerRate": safe_div(len(guard), total),
        "teacherProxyKnown": len(teacher_known),
        "teacherProxyFaceRelevant": len(teacher_relevant),
        "teacherProxyGatePrecision": safe_div(sum(1 for row in gate_teacher if row["teacherFaceRelevant"]), len(gate_teacher)),
        "teacherProxyGateRecall": safe_div(sum(1 for row in teacher_relevant if row["upstreamGateTriggered"]), len(teacher_relevant)),
        "teacherProxyGuardRealFaceCount": len(guard_real_face),
        "teacherProxyGuardFalseFaceHighRiskCount": len(guard_false_face),
        "teacherProxyGuardFalseFacePrecision": safe_div(len(guard_false_face), len(guard)),
        "meanElapsedMs": safe_div(sum(num(row.get("elapsedMs")) for row in results), total),
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    columns = [
        "photoId",
        "dataset",
        "imagePath",
        "proSceneLabel",
        "proFaceValidityScore",
        "proFalseFaceRisk",
        "teacherSceneType",
        "teacherSubjectType",
        "teacherHasRealHumanFace",
        "teacherFalseFaceRisk",
        "teacherFaceRelevant",
        "maxFacePresence",
        "reliableFacePresence",
        "faceCount",
        "reliableFaceCount",
        "selectedV15Risk",
        "lowThresholdProposal",
        "conflictRisk",
        "softConflictRisk",
        "upstreamGateTriggered",
        "guardTriggered",
        "elapsedMs",
        "error",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col) for col in columns})


def round_box(box: dict[str, Any]) -> dict[str, Any]:
    return {
        "x": round(float(box["x"]), 4),
        "y": round(float(box["y"]), 4),
        "width": round(float(box["width"]), 4),
        "height": round(float(box["height"]), 4),
        "confidence": round(float(box["confidence"]), 4),
        "source": box["source"],
    }


def infer_dataset(path: str) -> str:
    lower = path.lower()
    if "five-mountain" in lower:
        return "five_mountain"
    if "camera" in lower:
        return "camera"
    return "audit3groups"


def normalize_path(path: str) -> str:
    return path.replace("\\", "/").lower()


def clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


def safe_div(top: float, bottom: float) -> float:
    return top / bottom if bottom else 0.0


def num(value: Any) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return 0.0
    return out if math.isfinite(out) else 0.0


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


if __name__ == "__main__":
    main()
