#!/usr/bin/env python
"""Create 384px JPEG previews for the v13 independent holdout CSV."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def safe_stem(value: Any) -> str:
    text = str(value or "").strip().strip('"').strip("'")
    if not text:
        return ""
    key = Path(text).stem
    while True:
        inner = Path(key).stem
        if inner == key:
            return key
        key = inner


def make_preview(source: Path, target: Path, edge: int, quality: int) -> None:
    with Image.open(source) as image:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
        rgb.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", rgb.size, (0, 0, 0))
        canvas.paste(rgb, (0, 0))
    target.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(target, "JPEG", quality=quality, optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--independent-set", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--edge", type=int, default=384)
    parser.add_argument("--quality", type=int, default=88)
    parser.add_argument("--summary-json", default="")
    args = parser.parse_args()

    independent = read_csv(Path(args.independent_set))
    output_dir = Path(args.output_dir)
    created: list[str] = []
    skipped_existing: list[str] = []
    missing_source: list[str] = []
    failed: list[dict[str, str]] = []

    for row in independent:
        photo_id = safe_stem(row.get("photoId"))
        if not photo_id:
            continue
        target = output_dir / f"{photo_id}.jpg"
        if target.exists() and target.stat().st_size > 0:
            skipped_existing.append(photo_id)
            continue
        source = Path(str(row.get("absolutePath") or ""))
        if not source.exists():
            missing_source.append(photo_id)
            continue
        try:
            make_preview(source, target, args.edge, args.quality)
            created.append(photo_id)
        except Exception as exc:
            failed.append({"photoId": photo_id, "error": str(exc), "source": str(source)})

    payload = {
        "schemaVersion": "framecull-false-face-holdout-previews-v1",
        "independentSet": str(Path(args.independent_set)),
        "outputDir": str(output_dir),
        "rows": len(independent),
        "created": len(created),
        "skippedExisting": len(skipped_existing),
        "missingSource": missing_source,
        "failed": failed,
        "status": "ok" if not missing_source and not failed else "incomplete",
    }
    if args.summary_json:
        summary_path = Path(args.summary_json)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
