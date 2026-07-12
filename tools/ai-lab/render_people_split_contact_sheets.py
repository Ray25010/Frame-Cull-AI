from __future__ import annotations

import argparse
import base64
import io
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CELL_WIDTH = 184
CELL_HEIGHT = 226
IMAGE_SIZE = 160
PAGE_COLUMNS = 5
PAGE_ROWS = 4


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    payload = json.loads(args.input.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    face_by_key = {
        face["key"]: {**face, "fileName": result["fileName"]}
        for result in payload["results"]
        for face in result["faces"]
    }

    cluster_dir = args.output / "clusters"
    cluster_dir.mkdir(exist_ok=True)
    for cluster in payload["clusters"]:
        faces = [face_by_key[key] for key in cluster["memberFaceKeys"] if key in face_by_key]
        render_pages(
            faces,
            cluster_dir,
            cluster["id"],
            f'{cluster["id"]} | {len(faces)} faces | {cluster["photoCount"]} photos',
        )

    unassigned = [face_by_key[key] for key in payload["unassignedFaceKeys"] if key in face_by_key]
    render_pages(unassigned, args.output / "unassigned", "unassigned", f"Unassigned | {len(unassigned)} faces")


def render_pages(faces: list[dict], output_dir: Path, stem: str, title: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    page_size = PAGE_COLUMNS * PAGE_ROWS
    page_count = max(1, math.ceil(len(faces) / page_size))
    for page_index in range(page_count):
        page_faces = faces[page_index * page_size : (page_index + 1) * page_size]
        width = PAGE_COLUMNS * CELL_WIDTH
        height = 56 + PAGE_ROWS * CELL_HEIGHT
        canvas = Image.new("RGB", (width, height), "#101115")
        draw = ImageDraw.Draw(canvas)
        draw.text((16, 16), f"{title} | page {page_index + 1}/{page_count}", fill="#f4f4f5")
        for index, face in enumerate(page_faces):
            column = index % PAGE_COLUMNS
            row = index // PAGE_COLUMNS
            x = column * CELL_WIDTH
            y = 56 + row * CELL_HEIGHT
            draw_face_cell(canvas, draw, face, x, y)
        output_path = output_dir / f"{stem}-{page_index + 1:02d}.jpg"
        canvas.save(output_path, quality=92, optimize=True)


def draw_face_cell(canvas: Image.Image, draw: ImageDraw.ImageDraw, face: dict, x: int, y: int) -> None:
    draw.rectangle((x + 4, y + 4, x + CELL_WIDTH - 5, y + CELL_HEIGHT - 5), fill="#1c1d21", outline="#3f3f46")
    thumbnail = decode_thumbnail(face.get("thumbnail", ""))
    if thumbnail is not None:
        thumbnail.thumbnail((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.LANCZOS)
        image_x = x + (CELL_WIDTH - thumbnail.width) // 2
        image_y = y + 10 + (IMAGE_SIZE - thumbnail.height) // 2
        canvas.paste(thumbnail, (image_x, image_y))
    file_name = str(face.get("fileName", ""))
    face_index = face.get("faceIndex", "-")
    draw.text((x + 10, y + 174), f"{file_name[:20]} #{face_index}", fill="#f4f4f5")
    confidence = format_number(face.get("confidence"))
    quality = format_number(face.get("quality"))
    detector_confirmed = face.get("detectorConfirmed")
    detector_label = "Y" if detector_confirmed is True else "N" if detector_confirmed is False else "-"
    detector_iou = format_number(face.get("detectorConfirmationIoU"))
    admission = {
        "AUTO_ELIGIBLE": "A",
        "REVIEW_ONLY": "V",
        "REJECTED": "X",
    }.get(str(face.get("admission", "")), "-")
    draw.text((x + 10, y + 190), f"c={confidence} q={quality}", fill="#d4d4d8")
    draw.text((x + 10, y + 206), f"a={admission} mp={detector_label} iou={detector_iou}", fill="#a1a1aa")


def decode_thumbnail(value: str) -> Image.Image | None:
    if not value.startswith("data:image/") or "," not in value:
        return None
    encoded = value.split(",", 1)[1]
    try:
        return Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
    except Exception:
        return None


def format_number(value: object) -> str:
    return f"{float(value):.2f}" if isinstance(value, (int, float)) else "-"


if __name__ == "__main__":
    main()
