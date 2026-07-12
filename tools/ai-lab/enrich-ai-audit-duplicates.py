#!/usr/bin/env python
"""Add duplicate signatures and visual-similarity groups to an existing AI audit.

This is intentionally lab-only. It reuses already-generated JPG previews so a
large RAW+XMP audit can get pair similarities without rerunning the full AI
worker pipeline.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageFile, ImageOps

ImageFile.LOAD_TRUNCATED_IMAGES = True


SIGNATURE_VERSION = "duplicate-signature-v1"
SCHEMA = "framecull-ai-audit-duplicate-enriched-v1"

THRESHOLDS = {
    "loose": {
        "min_similarity": 0.76,
        "max_hash_distance": 24,
        "max_aspect_delta": 0.08,
        "candidate_window_ms": 1000 * 60 * 60 * 6,
        "max_group_size": 8,
    },
    "standard": {
        "min_similarity": 0.84,
        "max_hash_distance": 18,
        "max_aspect_delta": 0.045,
        "candidate_window_ms": 1000 * 60 * 45,
        "max_group_size": 6,
    },
    "strict": {
        "min_similarity": 0.92,
        "max_hash_distance": 10,
        "max_aspect_delta": 0.02,
        "candidate_window_ms": 1000 * 60 * 8,
        "max_group_size": 5,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Enrich FrameCull audit JSON with duplicate signatures and pair similarities.")
    parser.add_argument("--audit", required=True, help="Existing ai-culling-bench JSON.")
    parser.add_argument("--previews", default=r"D:\FrameCullRawAudit\raw-audit-previews", help="Directory containing JPG previews.")
    parser.add_argument("--output", help="Output JSON path. Defaults to output/ai-bench/<audit>-duplicate-enriched.json")
    parser.add_argument("--sensitivity", choices=["loose", "standard", "strict"], default="standard")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0, help="Optional photo limit for smoke tests.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    started = time.perf_counter()
    audit_path = Path(args.audit)
    preview_dir = Path(args.previews)
    with audit_path.open("r", encoding="utf-8") as handle:
      audit = json.load(handle)

    photo_summaries = list(audit.get("photoSummaries") or [])
    if args.limit > 0:
        photo_summaries = photo_summaries[: args.limit]
    if not photo_summaries:
        raise SystemExit("Audit has no photoSummaries.")

    previews = index_previews(preview_dir)
    signatures, signature_errors = compute_signatures(photo_summaries, previews, max(1, args.workers))
    enriched_summaries = []
    missing = []
    for summary in photo_summaries:
        signature = signatures.get(summary["id"])
        enriched = dict(summary)
        enriched.setdefault("scoreComponents", score_components_from_summary(enriched))
        if signature is None:
            missing.append(summary["id"])
            enriched_summaries.append(enriched)
            continue
        enriched["duplicateSignature"] = signature
        enriched_summaries.append(enriched)

    pairs = pair_similarities(enriched_summaries, args.sensitivity)
    compact_groups = compact_duplicate_groups(enriched_summaries, args.sensitivity)
    burst_groups = infer_burst_groups(enriched_summaries, pairs)

    enriched_audit = dict(audit)
    enriched_audit["schema"] = SCHEMA
    enriched_audit["duplicateEnrichment"] = {
        "schema": SCHEMA,
        "createdAt": iso_now(),
        "sourceAudit": str(audit_path),
        "previewDir": str(preview_dir),
        "sensitivity": args.sensitivity,
        "photos": len(photo_summaries),
        "signatures": len(signatures),
        "missingSignatures": len(missing),
        "signatureErrors": len(signature_errors),
        "signatureErrorSamples": signature_errors[:8],
        "pairSimilarities": len(pairs),
        "compactDuplicateGroups": len(compact_groups),
        "burstGroups": len(burst_groups),
        "elapsedSeconds": round(time.perf_counter() - started, 3),
    }
    enriched_audit["photoSummaries"] = enriched_summaries
    enriched_audit["pairSimilarities"] = pairs
    enriched_audit["compactDuplicateGroups"] = compact_groups
    enriched_audit["burstGroups"] = burst_groups

    output_path = Path(args.output) if args.output else audit_path.with_name(f"{audit_path.stem}-duplicate-enriched.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(enriched_audit, handle, ensure_ascii=False, indent=2)

    print(json.dumps({
        "output": str(output_path),
        **enriched_audit["duplicateEnrichment"],
        "firstMissing": missing[:8],
    }, ensure_ascii=False, indent=2))


def index_previews(preview_dir: Path) -> dict[str, Path]:
    previews: dict[str, Path] = {}
    for path in preview_dir.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}:
            previews[path.stem] = path
    return previews


def compute_signatures(photo_summaries: list[dict[str, Any]], previews: dict[str, Path], workers: int) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    signatures: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {}
        for summary in photo_summaries:
            photo_id = summary.get("id")
            if not photo_id:
                continue
            preview = previews.get(photo_id) or previews.get(Path(str(summary.get("fileName", ""))).stem)
            if preview is None:
                continue
            futures[pool.submit(build_duplicate_signature, preview)] = photo_id
        for future in as_completed(futures):
            photo_id = futures[future]
            try:
                signatures[photo_id] = future.result()
            except Exception as exc:
                errors.append({"id": photo_id, "error": str(exc)})
    return signatures, errors


def build_duplicate_signature(path: Path) -> dict[str, Any]:
    image = Image.open(path)
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size
    rgb = np.asarray(image, dtype=np.uint8)
    luma = (0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]).astype(np.float32)
    luma_hash = difference_hash(luma, 9, 8, "luma")
    structure_hash = difference_hash(luma, 9, 8, "edge")
    color_hist = color_histogram(rgb)
    luma_histogram = normalized_histogram(luma, 16, 0, 256)
    mean_luma = float(sum(value * ((index + 0.5) / len(luma_histogram)) * 255 for index, value in enumerate(luma_histogram)))
    return {
        "version": SIGNATURE_VERSION,
        "width": int(width),
        "height": int(height),
        "aspectRatio": float(width / max(1, height)),
        "lumaHash": luma_hash,
        "structureHash": structure_hash,
        "colorHistogram": color_hist,
        "lumaHistogram": luma_histogram,
        "meanLuma": mean_luma,
    }


def score_components_from_summary(summary: dict[str, Any]) -> list[dict[str, Any]]:
    components = []
    mapping = [
        ("TECHNICAL_QUALITY", "Technical quality", summary.get("technical"), 35),
        ("AESTHETIC_QUALITY", "Aesthetic quality", summary.get("aesthetic"), 25),
        ("SCENE_FIT", "Scene fit", summary.get("scene"), 15),
        ("EXPOSURE_LATITUDE", "Exposure latitude", summary.get("overall"), 15),
        ("AI_RISK", "AI risk", 100 if not summary.get("issueCodes") else max(0, 100 - len(summary.get("issueCodes") or []) * 20), 10),
    ]
    for key, label, value, weight in mapping:
        if value is None:
            continue
        components.append({
            "key": key,
            "label": label,
            "score": float(value),
            "weight": weight,
        })
    return components


def difference_hash(luma: np.ndarray, width: int, height: int, mode: str) -> str:
    resized = cv2.resize(luma, (width, height), interpolation=cv2.INTER_AREA)
    bits: list[str] = []
    for y in range(height):
        for x in range(width - 1):
            current = resized[y, x]
            next_value = resized[y, x + 1]
            if mode == "edge":
                below = resized[min(height - 1, y + 1), x]
                below_next = resized[min(height - 1, y + 1), x + 1]
                bits.append("1" if abs(current - below) > abs(next_value - below_next) else "0")
            else:
                bits.append("1" if current > next_value else "0")
    return bits_to_hex("".join(bits))


def bits_to_hex(bits: str) -> str:
    chars = []
    for index in range(0, len(bits), 4):
        chars.append(format(int(bits[index:index + 4].ljust(4, "0"), 2), "x"))
    return "".join(chars)


def color_histogram(rgb: np.ndarray) -> list[float]:
    flat = rgb.reshape(-1, 3)
    stride = max(1, len(flat) // 12000)
    sample = flat[::stride]
    bins = np.zeros(24, dtype=np.float64)
    for channel in range(3):
        values = np.minimum(7, sample[:, channel] >> 5)
        counts = np.bincount(values, minlength=8)
        bins[channel * 8:(channel + 1) * 8] = counts
    total = max(1, len(sample))
    return [float(value / total) for value in bins]


def normalized_histogram(values: np.ndarray, bins: int, low: float, high: float) -> list[float]:
    flat = values.reshape(-1)
    stride = max(1, len(flat) // 12000)
    hist, _ = np.histogram(flat[::stride], bins=bins, range=(low, high))
    total = max(1, int(hist.sum()))
    return [float(value / total) for value in hist]


def pair_similarities(photo_summaries: list[dict[str, Any]], sensitivity: str) -> list[dict[str, Any]]:
    thresholds = THRESHOLDS[sensitivity]
    photos = signature_photos(photo_summaries)
    pairs = []
    for left_index, left in enumerate(photos):
        for right in photos[left_index + 1:]:
            numeric_gap = filename_numeric_gap(left["id"], right["id"])
            time_gap_ms = time_gap(left, right)
            nearby_by_name = numeric_gap is not None and numeric_gap <= 24
            nearby_by_time = time_gap_ms is not None and time_gap_ms <= thresholds["candidate_window_ms"]
            if not nearby_by_name and not nearby_by_time and not is_likely_candidate_pair(left, right, thresholds):
                continue
            left_sig = left["duplicateSignature"]
            right_sig = right["duplicateSignature"]
            similarity = duplicate_similarity(left_sig, right_sig)
            luma_distance = hamming_distance(left_sig["lumaHash"], right_sig["lumaHash"])
            structure_distance = hamming_distance(left_sig["structureHash"], right_sig["structureHash"])
            aspect_delta = abs(float(left_sig["aspectRatio"]) - float(right_sig["aspectRatio"]))
            pairs.append({
                "leftId": left["id"],
                "rightId": right["id"],
                "similarity": similarity,
                "lumaHashDistance": luma_distance,
                "structureHashDistance": structure_distance,
                "aspectDelta": aspect_delta,
                "timeGapMs": time_gap_ms,
                "numericGap": numeric_gap,
                "candidate": bool(is_likely_candidate_pair(left, right, thresholds) and similarity >= thresholds["min_similarity"]),
            })
    return sorted(pairs, key=lambda pair: (
        pair["numericGap"] if pair["numericGap"] is not None else math.inf,
        -pair["similarity"],
        pair["leftId"],
        pair["rightId"],
    ))


def compact_duplicate_groups(photo_summaries: list[dict[str, Any]], sensitivity: str) -> list[dict[str, Any]]:
    thresholds = THRESHOLDS[sensitivity]
    buckets: list[list[dict[str, Any]]] = []
    for photo in signature_photos(photo_summaries):
        target = next((bucket for bucket in buckets if len(bucket) < thresholds["max_group_size"] and can_join_bucket(photo, bucket, thresholds)), None)
        if target is None:
            buckets.append([photo])
        else:
            target.append(photo)
    groups = []
    for index, bucket in enumerate(bucket for bucket in buckets if len(bucket) >= 2):
        best = best_photo(bucket)
        similarities = [
            duplicate_similarity(left["duplicateSignature"], right["duplicateSignature"])
            for left_index, left in enumerate(bucket)
            for right in bucket[left_index + 1:]
        ]
        groups.append({
            "id": f"duplicate-{index + 1}-{bucket[0]['id']}",
            "photoIds": [photo["id"] for photo in bucket],
            "similarity": float(sum(similarities) / max(1, len(similarities))),
            "bestPhotoId": best["id"] if best else None,
        })
    return groups


def infer_burst_groups(photo_summaries: list[dict[str, Any]], pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_pair = {
        tuple(sorted([pair["leftId"], pair["rightId"]])): pair
        for pair in pairs
    }
    photos = sorted(signature_photos(photo_summaries), key=photo_sort_key)
    groups = []
    current: list[dict[str, Any]] = []
    for photo in photos:
        if current and should_join_burst(photo, current, by_pair):
            current.append(photo)
            continue
        push_burst_group(groups, current)
        current = [photo]
    push_burst_group(groups, current)
    return groups


def should_join_burst(photo: dict[str, Any], current: list[dict[str, Any]], by_pair: dict[tuple[str, str], dict[str, Any]]) -> bool:
    if len(current) >= 5:
        return False
    previous = current[-1]
    anchor = current[0]
    previous_pair = by_pair.get(tuple(sorted([photo["id"], previous["id"]])))
    anchor_pair = by_pair.get(tuple(sorted([photo["id"], anchor["id"]])))
    if not previous_pair or not anchor_pair:
        return False
    gap = filename_numeric_gap(photo["id"], previous["id"])
    if gap is None:
        return False
    return (
        previous_pair["similarity"] >= 0.88 and
        anchor_pair["similarity"] >= 0.84 and
        gap <= 3
    )


def push_burst_group(groups: list[dict[str, Any]], current: list[dict[str, Any]]) -> None:
    if len(current) < 2:
        return
    representative = best_photo(current)
    groups.append({
        "kind": "burst",
        "representativeId": representative["id"] if representative else current[0]["id"],
        "photoIds": [photo["id"] for photo in current],
        "selectedCount": sum(1 for photo in current if photo.get("picked")),
    })


def signature_photos(photo_summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        [
            photo for photo in photo_summaries
            if photo.get("status") == "DONE" and photo.get("duplicateSignature", {}).get("version") == SIGNATURE_VERSION
        ],
        key=photo_sort_key,
    )


def can_join_bucket(photo: dict[str, Any], bucket: list[dict[str, Any]], thresholds: dict[str, Any]) -> bool:
    return all(
        is_likely_candidate_pair(member, photo, thresholds) and
        duplicate_similarity(member["duplicateSignature"], photo["duplicateSignature"]) >= thresholds["min_similarity"]
        for member in bucket
    )


def duplicate_similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    hash_similarity = 1 - min(1, hamming_distance(left["lumaHash"], right["lumaHash"]) / 64)
    structure_similarity = 1 - min(1, hamming_distance(left["structureHash"], right["structureHash"]) / 64)
    color_similarity = 1 - histogram_distance(left["colorHistogram"], right["colorHistogram"])
    luma_similarity = 1 - histogram_distance(left["lumaHistogram"], right["lumaHistogram"])
    aspect_penalty = min(1, abs(float(left["aspectRatio"]) - float(right["aspectRatio"])) / 0.16)
    return clamp01(hash_similarity * 0.4 + structure_similarity * 0.24 + color_similarity * 0.2 + luma_similarity * 0.12 + (1 - aspect_penalty) * 0.04)


def is_likely_candidate_pair(left: dict[str, Any], right: dict[str, Any], thresholds: dict[str, Any]) -> bool:
    left_sig = left["duplicateSignature"]
    right_sig = right["duplicateSignature"]
    if abs(float(left_sig["aspectRatio"]) - float(right_sig["aspectRatio"])) > thresholds["max_aspect_delta"]:
        return False
    hash_distance = min(
        hamming_distance(left_sig["lumaHash"], right_sig["lumaHash"]),
        hamming_distance(left_sig["structureHash"], right_sig["structureHash"]),
    )
    if hash_distance > thresholds["max_hash_distance"]:
        return False
    return True


def best_photo(bucket: list[dict[str, Any]]) -> dict[str, Any] | None:
    usable = [photo for photo in bucket if is_usable(photo)]
    if not usable:
        return None
    return max(usable, key=rank_score)


def is_usable(photo: dict[str, Any]) -> bool:
    if photo.get("status") != "DONE":
        return False
    if photo.get("hardIssueCodes"):
        return False
    if "FOCUS_FAIL" in (photo.get("exclusionReasons") or []):
        return False
    if has_focus_fail(photo):
        return False
    if float(photo.get("overall") or 0) < 38:
        return False
    if float(photo.get("technical") or 0) < 20:
        return False
    return True


def has_focus_fail(photo: dict[str, Any]) -> bool:
    issues = photo.get("issueCodes") or []
    hard = photo.get("hardIssueCodes") or []
    if "ISSUE:OUT_OF_FOCUS" in issues or "OUT_OF_FOCUS" in hard:
        return True
    focus_texture = float(photo.get("focusTexture") if photo.get("focusTexture") is not None else 100)
    focus_peak = float(photo.get("focusPeakTexture") if photo.get("focusPeakTexture") is not None else 100)
    reliability = float(photo.get("focusReliability") if photo.get("focusReliability") is not None else (0.38 if photo.get("focusReliable") is False else 1))
    return focus_texture < 30 and focus_peak < 38 and reliability < 0.42


def rank_score(photo: dict[str, Any]) -> float:
    overall = float(photo.get("overall") or 0)
    technical = float(photo.get("technical") or 0)
    aesthetic = float(photo.get("aesthetic") or 0)
    scene = float(photo.get("scene") or 0)
    focus_texture = float(photo.get("focusTexture") or 0)
    focus_peak = float(photo.get("focusPeakTexture") or 0)
    reliability = float(photo.get("focusReliability") if photo.get("focusReliability") is not None else 0.5)
    review_penalty = len(photo.get("reviewHintCodes") or []) * 4
    return overall * 0.72 + technical * 0.62 + scene * 0.18 + aesthetic * 0.18 + min(max(focus_texture, focus_peak), 65) * 0.22 + reliability * 6 - review_penalty


def hamming_distance(left: str, right: str) -> int:
    max_length = max(len(left), len(right))
    distance = 0
    for index in range(max_length):
        a = int(left[index], 16) if index < len(left) else 0
        b = int(right[index], 16) if index < len(right) else 0
        distance += int((a ^ b).bit_count())
    return distance


def histogram_distance(left: list[float], right: list[float]) -> float:
    length = max(len(left), len(right))
    distance = sum(abs((left[index] if index < len(left) else 0) - (right[index] if index < len(right) else 0)) for index in range(length))
    return min(1, distance / 2)


def photo_sort_key(photo: dict[str, Any]) -> tuple[str, int, str]:
    return (source_folder(photo), trailing_number(photo.get("id")) or 2**31, str(photo.get("id") or ""))


def source_folder(photo: dict[str, Any]) -> str:
    source = str(photo.get("sourceName") or "")
    match = re.search(r"(108NZ6_3|109NZ6_3|110NZ6_3)", source)
    if match:
        return match.group(1)
    return "unknown"


def time_gap(left: dict[str, Any], right: dict[str, Any]) -> int | None:
    return None


def filename_numeric_gap(left: str, right: str) -> int | None:
    left_number = trailing_number(left)
    right_number = trailing_number(right)
    if left_number is None or right_number is None:
        return None
    return abs(left_number - right_number)


def trailing_number(value: Any) -> int | None:
    match = re.search(r"(\d+)(?!.*\d)", str(value or ""))
    return int(match.group(1)) if match else None


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


if __name__ == "__main__":
    main()
