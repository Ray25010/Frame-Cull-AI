#!/usr/bin/env python
"""Prepare high-resolution teacher JPEGs from original photo files.

The Semantic Teacher must not read 384px student previews. VLM backends also
cannot reliably read camera RAW files directly, so this helper creates a
separate high-resolution JPEG teacher image set from originals:

- JPEG/PNG originals are copied/resized without changing the source file.
- RAW originals use embedded JPEG preview first, then rawpy postprocess fallback.
- Output is keyed by original stem: <stem>.jpg.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import shutil
import time
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageOps

RAW_EXTENSIONS = {".arw", ".cr2", ".cr3", ".nef", ".raf", ".dng", ".rw2", ".orf"}
IMAGE_EXTENSIONS = RAW_EXTENSIONS | {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}


def iter_images(input_dirs: Iterable[Path]) -> list[Path]:
    paths: list[Path] = []
    for root in input_dirs:
        if not root.exists():
            print(f"[warn] input dir missing: {root}", flush=True)
            continue
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                paths.append(path)
    return sorted(paths, key=lambda p: (p.stem.lower(), p.suffix.lower(), str(p)))


def load_raw_preview(path: Path) -> Image.Image:
    import rawpy

    with rawpy.imread(str(path)) as raw:
        try:
            thumb = raw.extract_thumb()
            if thumb.format == rawpy.ThumbFormat.JPEG:
                return Image.open(io.BytesIO(thumb.data)).convert("RGB")
            if thumb.format == rawpy.ThumbFormat.BITMAP:
                return Image.fromarray(thumb.data).convert("RGB")
        except Exception as error:
            print(f"[warn] embedded preview failed {path}: {error}", flush=True)
        rgb = raw.postprocess(
            use_camera_wb=True,
            no_auto_bright=True,
            output_bps=8,
            half_size=True,
        )
        return Image.fromarray(rgb).convert("RGB")


def load_image(path: Path) -> Image.Image:
    if path.suffix.lower() in RAW_EXTENSIONS:
        return load_raw_preview(path)
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)
    return image.convert("RGB")


def resize_for_teacher(image: Image.Image, max_edge: int) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest <= max_edge:
        return image
    scale = max_edge / float(longest)
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def prepare_one(path: Path, output_dir: Path, max_edge: int, quality: int, force: bool) -> dict:
    out = output_dir / f"{path.stem}.jpg"
    if out.exists() and not force:
        try:
            with Image.open(out) as image:
                width, height = image.size
            return {
                "source": str(path),
                "output": str(out),
                "status": "exists",
                "width": width,
                "height": height,
                "bytes": out.stat().st_size,
            }
        except Exception:
            pass
    image = load_image(path)
    image = resize_for_teacher(image, max_edge)
    output_dir.mkdir(parents=True, exist_ok=True)
    image.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)
    return {
        "source": str(path),
        "output": str(out),
        "status": "written",
        "width": image.size[0],
        "height": image.size[1],
        "bytes": out.stat().st_size,
    }


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dirs", help="Semicolon-separated original image directories")
    parser.add_argument("--input", dest="input_dirs_alias", help="Alias for --input-dirs; kept for task-book commands")
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-edge", type=int, default=2048)
    parser.add_argument("--quality", type=int, default=92)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    input_dirs_text = args.input_dirs or args.input_dirs_alias
    if not input_dirs_text:
        parser.error("one of --input-dirs or --input is required")
    input_dirs = [Path(item) for item in input_dirs_text.split(";") if item.strip()]
    output_dir = Path(args.out)
    started = time.time()
    paths = iter_images(input_dirs)
    if args.limit:
        paths = paths[: args.limit]
    rows: list[dict] = []
    failures: list[dict] = []
    seen_stems: set[str] = set()
    collisions: list[dict] = []
    for index, path in enumerate(paths, 1):
        if path.stem.lower() in seen_stems:
            collisions.append({"stem": path.stem, "source": str(path)})
            continue
        seen_stems.add(path.stem.lower())
        try:
            row = prepare_one(path, output_dir, args.max_edge, args.quality, args.force)
            rows.append(row)
        except Exception as error:
            failures.append({"source": str(path), "error": str(error)})
            print(f"[fail] {path}: {error}", flush=True)
        if index % 50 == 0:
            print(f"[prepare-teacher-images] {index}/{len(paths)} written_or_existing={len(rows)} failures={len(failures)}", flush=True)

    output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(output_dir / "teacher-image-manifest.csv", rows, ["source", "output", "status", "width", "height", "bytes"])
    write_csv(output_dir / "teacher-image-failures.csv", failures, ["source", "error"])
    write_csv(output_dir / "teacher-image-collisions.csv", collisions, ["stem", "source"])
    summary = {
        "schema": "framecull-semantic-teacher-images-v1",
        "inputDirs": [str(path) for path in input_dirs],
        "outputDir": str(output_dir),
        "maxEdge": args.max_edge,
        "quality": args.quality,
        "scanned": len(paths),
        "prepared": len(rows),
        "failures": len(failures),
        "collisions": len(collisions),
        "elapsedS": time.time() - started,
        "note": "These are high-resolution teacher JPEGs generated from originals; they are not 384px student previews.",
    }
    (output_dir / "teacher-image-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("==TEACHER_IMAGES_DONE==", json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
