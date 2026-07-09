#!/usr/bin/env python
"""Render paginated contact sheets for false-face human review."""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def load_font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def fit_cover(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return ImageOps.fit(image.convert("RGB"), size, method=Image.Resampling.LANCZOS)


def draw_multiline(draw: ImageDraw.ImageDraw, xy: tuple[int, int], lines: list[str], font: ImageFont.ImageFont, fill: str) -> None:
    x, y = xy
    line_gap = 4
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        bbox = draw.textbbox((x, y), line, font=font)
        y = bbox[3] + line_gap


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-csv", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--rows", type=int, default=4)
    parser.add_argument("--thumb-width", type=int, default=300)
    parser.add_argument("--thumb-height", type=int, default=220)
    args = parser.parse_args()

    rows = read_csv(Path(args.input_csv))
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    columns = max(1, args.columns)
    grid_rows = max(1, args.rows)
    thumb_w = max(120, args.thumb_width)
    thumb_h = max(120, args.thumb_height)
    caption_h = 86
    pad = 18
    page_w = pad + columns * (thumb_w + pad)
    page_h = pad + grid_rows * (thumb_h + caption_h + pad)

    font_title = load_font(18)
    font_body = load_font(14)
    font_small = load_font(13)

    items_per_page = columns * grid_rows
    total_pages = max(1, math.ceil(len(rows) / items_per_page))

    for page_index in range(total_pages):
        page = Image.new("RGB", (page_w, page_h), (18, 20, 24))
        draw = ImageDraw.Draw(page)
        start = page_index * items_per_page
        chunk = rows[start:start + items_per_page]
        for item_index, row in enumerate(chunk):
            col = item_index % columns
            r = item_index // columns
            x = pad + col * (thumb_w + pad)
            y = pad + r * (thumb_h + caption_h + pad)

            image_path = Path(str(row.get("localImagePath") or row.get("absolutePath") or ""))
            try:
                image = Image.open(image_path)
                thumb = fit_cover(image, (thumb_w, thumb_h))
            except Exception:
                thumb = Image.new("RGB", (thumb_w, thumb_h), (52, 58, 66))
                thumb_draw = ImageDraw.Draw(thumb)
                thumb_draw.text((12, 12), "missing", font=font_title, fill=(230, 230, 230))

            page.paste(thumb, (x, y))
            draw.rectangle((x, y, x + thumb_w, y + thumb_h), outline=(72, 78, 86), width=1)

            photo_id = str(row.get("photoId") or "")
            scene = str(row.get("candidateScene") or row.get("scene") or "")
            v11_risk = to_float(row.get("v11FalseFaceRisk"))
            v12_risk = to_float(row.get("v12FalseFaceRisk"))
            teacher_risk = to_float(row.get("teacherFalseFaceRisk"))
            lines = [
                photo_id,
                f"{scene} | {row.get('source', row.get('sampleRole', ''))}",
                f"teacher {teacher_risk:.3f} | v11 {v11_risk:.3f} | v12 {v12_risk:.3f}",
            ]
            draw_multiline(draw, (x, y + thumb_h + 8), lines, font_body, "#f3f4f6")

            badge_text = f"#{start + item_index + 1}"
            badge_bbox = draw.textbbox((0, 0), badge_text, font=font_small)
            badge_w = badge_bbox[2] - badge_bbox[0] + 14
            badge_h = badge_bbox[3] - badge_bbox[1] + 8
            draw.rounded_rectangle((x + 8, y + 8, x + 8 + badge_w, y + 8 + badge_h), radius=8, fill=(15, 23, 42))
            draw.text((x + 15, y + 12), badge_text, font=font_small, fill="#e5e7eb")

        header = f"FrameCull v13 Phase 3 False-Face Review Shortlist  page {page_index + 1}/{total_pages}"
        draw.text((pad, 6), header, font=font_small, fill="#94a3b8")
        page.save(output_dir / f"phase3-shortlist-sheet-{page_index + 1:02d}.jpg", quality=92)

    manifest_lines = [
        "# Phase 3 Shortlist Review Pack",
        "",
        f"- source csv: `{Path(args.input_csv)}`",
        f"- pages: `{total_pages}`",
        f"- items: `{len(rows)}`",
        "",
        "Human review fill targets in the CSV:",
        "- `humanConfirmUseForTraining`",
        "- `humanConfirmHasRealHumanFace`",
        "- `humanConfirmScene`",
        "- `humanConfirmIllusionReason`",
        "",
        "Do not mark holdout photos into training. The shortlist builder already excluded holdout ids.",
        "",
    ]
    (output_dir / "README.md").write_text("\n".join(manifest_lines), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
