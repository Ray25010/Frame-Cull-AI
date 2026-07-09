#!/usr/bin/env python
"""Run Semantic Teacher annotation for FrameCull Pro.

Official full annotation should use a cleared local VLM such as Qwen2.5-VL on
high-resolution originals. The heuristic backend is only a deterministic smoke
path for validating schema/output plumbing when the VLM weights are not present.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageFile, ImageStat

from semantic_teacher_schema import SCHEMA_VERSION, normalize_record, validate_record


ImageFile.LOAD_TRUNCATED_IMAGES = True


PROMPT_GROUNDED = """You are FrameCull Pro Semantic Teacher.

Analyze the photo content for professional photo culling. Do not use file name,
path, star rating, or any metadata as evidence. Use only visual content.

Return STRICT JSON only. Scores are 0..1.
The runner fills provenance fields itself. Do NOT invent or include placeholder
values for schemaVersion, photoId, imagePath, teacherModel, teacherVersion, or
createdAt.

sceneType must be exactly one of:
- portrait
- group
- environmental_portrait
- landscape
- empty_scene
- documentary_moment
- event
- product_object
- animal
- food
- other

Choose event for presentations, lectures, conferences, ceremonies, meetings,
classroom activities, and social gatherings. Choose product_object for objects,
merchandise displays, still-life setups, vehicles, and detail-only object
scenes. Choose other only when none of the allowed scene types fits.

Required reasoning:
1. First create reasoningTrace entries. Each entry must have:
   - region: normalized [x1,y1,x2,y2]
   - observation: concrete visual evidence in that region
   - supportsKeep: true/false
   - weight: 0..1
2. For every suspected face-like region, create faceRegionVerdicts entries:
   - region
   - isRealHumanFace
   - evidence: why it is or is not a real human face using context
   - confidence
3. Then aggregate scores from the trace and verdicts.

Special rules:
- Empty scenes, landscapes, atmosphere, documentary moments, and environmental
  portraits can be valuable even without a face.
- Round objects such as tires, lights, posters, logos, signs, patterns, rocks,
  tree trunks, clouds, building textures, mannequins, statues, and sculptures
  are not faces unless the surrounding body/context clearly supports a real
  human face.
- If the face is distant, partial, tiny, blurry, or only vaguely implied by
  shape, prefer hasRealHumanFace=false.
- Cyclists, riders, helmeted people, masked people, goggles, visors, and
  side/back views are not automatic faces. If facial anatomy is not clearly
  visible, keep hasRealHumanFace=false even when the person or body is obvious.
- Do not promote a person-shaped subject to hasRealHumanFace=true just because
  the frame contains a human activity, a group, or a moment worth keeping.
- If hasRealHumanFace is true, faceRegionVerdicts must include at least one
  entry with isRealHumanFace=true. Do not leave faceRegionVerdicts empty when
  claiming a real human face is present.
- If there is no face-like region at all, faceRegionVerdicts should be [].
- If you cannot localize any real-human-face region, set hasRealHumanFace=false
  and lower faceValidityScore instead of claiming a real face without evidence.
- Landscape and empty_scene frames should usually stay conservative: a distant
  person-like blob, a branch knot, a face-like rock pattern, or sky texture must
  not become a real face without explicit facial structure.
- Documentary_moment frames should only mark a face when a clearly visible human
  face is supported by local evidence; do not upgrade ambiguous crowd shapes.
- Product_object frames almost never contain a real human face; default to false
  unless a clearly visible person is part of the scene itself.
- If uncertain, add field names to uncertain instead of inventing certainty.
- uncertain must be a JSON array of short strings such as
  ["sceneType", "semanticKeepScore"]; never output objects in uncertain.

Score calibration for semanticKeepScore:
- 0.00-0.20: obvious reject, filler, or unusable record shot
- 0.20-0.40: weak image, mostly reject
- 0.40-0.60: borderline, context-only, or modest record value
- 0.60-0.80: solid usable keep
- 0.80-1.00: only for clearly strong, standout, or key-deliverable images
- Do not collapse ordinary coverage shots into 0.8-0.9 by default.
- Static setup shots of tables, empty room prep, branded merchandise, name tags,
  bottles, or object-only event preparation usually stay at or below 0.55 unless
  they have unusually strong story, composition, or documentary value.

Reason list rules:
- keepReasons: 0-3 short positive reasons that truly support keeping.
- rejectReasons: 0-3 short negative reasons only. If there is no real negative
  evidence, return [].
- Never put "no issue", "no significant technical problem", or other
  absence-of-problem statements into rejectReasons.

Return only these JSON fields:
sceneType, sceneConfidence, subjectType, subjectConfidence, hasRealHumanFace,
faceValidityScore, falseFaceRisk, semanticKeepScore, compositionScore,
momentScore, lightingMoodScore, storytellingScore, scenicValueScore,
technicalVisibleIssueScore, emptyOrFillerScore, duplicateRepresentativeHint,
keepReasons, rejectReasons, reasoningTrace, faceRegionVerdicts, regions,
uncertain.
"""


PROMPT_FLAT = """You are FrameCull Pro flat-scalar ablation teacher.

Analyze the photo content for professional photo culling. Do not use file name,
path, star rating, or metadata. Return STRICT JSON only. Scores are 0..1.
The runner fills provenance fields itself. Do NOT invent or include placeholder
values for schemaVersion, photoId, imagePath, teacherModel, teacherVersion, or
createdAt.

sceneType must be exactly one of:
- portrait
- group
- environmental_portrait
- landscape
- empty_scene
- documentary_moment
- event
- product_object
- animal
- food
- other

Choose event for presentations, lectures, conferences, ceremonies, meetings,
classroom activities, and social gatherings. Choose product_object for objects,
merchandise displays, still-life setups, vehicles, and detail-only object
scenes. Choose other only when none of the allowed scene types fits.

This is the flat-scalar ablation: do NOT include reasoningTrace or
faceRegionVerdicts. Give only final scalar fields and short keep/reject reasons.

Score calibration for semanticKeepScore:
- 0.00-0.20: obvious reject, filler, or unusable record shot
- 0.20-0.40: weak image, mostly reject
- 0.40-0.60: borderline, context-only, or modest record value
- 0.60-0.80: solid usable keep
- 0.80-1.00: only for clearly strong, standout, or key-deliverable images
- Do not collapse ordinary coverage shots into 0.8-0.9 by default.
- Static setup shots of tables, empty room prep, branded merchandise, name tags,
  bottles, or object-only event preparation usually stay at or below 0.55 unless
  they have unusually strong story, composition, or documentary value.

Reason list rules:
- keepReasons: 0-3 short positive reasons that truly support keeping.
- rejectReasons: 0-3 short negative reasons only. If there is no real negative
  evidence, return [].
- Never put "no issue", "no significant technical problem", or other
  absence-of-problem statements into rejectReasons.
- uncertain must be a JSON array of short strings naming uncertain fields, never
  objects.

Return only these JSON fields:
sceneType, sceneConfidence, subjectType, subjectConfidence, hasRealHumanFace,
faceValidityScore, falseFaceRisk, semanticKeepScore, compositionScore,
momentScore, lightingMoodScore, storytellingScore, scenicValueScore,
technicalVisibleIssueScore, emptyOrFillerScore, duplicateRepresentativeHint,
keepReasons, rejectReasons, regions, uncertain.
"""


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_done(path: Path) -> set[str]:
    done = set()
    if not path.exists():
        return done
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("photoId") and row.get("dataset"):
                done.add(f"{row['dataset']}::{row['photoId']}")
    return done


def count_jsonl_rows(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def build_run_summary(
    *,
    args: argparse.Namespace,
    total_items: int,
    preview_fallback_items: list[dict[str, Any]],
    started: float,
    success_lines: int,
    written_this_run: int,
    failure_count: int,
    current_index: int,
    current_key: str | None,
    interrupted_reason: str | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": "framecull-semantic-teacher-run-v1",
        "backend": args.backend,
        "model": args.model,
        "flatScalar": args.flat_scalar,
        "input": str(args.input),
        "inputSha256": file_sha256(args.input),
        "output": str(args.out),
        "items": total_items,
        "previewFallbackInputs": len(preview_fallback_items),
        "written": success_lines,
        "writtenThisRun": written_this_run,
        "successLines": success_lines,
        "completed": success_lines + failure_count,
        "remaining": max(0, total_items - (success_lines + failure_count)),
        "failures": failure_count,
        "elapsedS": time.time() - started,
        "currentIndex": current_index,
        "currentKey": current_key,
        "interrupted": interrupted_reason is not None,
        "interruptedReason": interrupted_reason,
    }


def write_run_summary(path: Path | None, summary: dict[str, Any]) -> None:
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        text = fenced.group(1)
    elif not text.startswith("{"):
        match = re.search(r"\{.*\}", text, re.S)
        if match:
            text = match.group(0)
    try:
        return json.loads(text)
    except json.JSONDecodeError as first_error:
        try:
            from json_repair import repair_json
        except Exception:
            raise first_error
        repaired = repair_json(text)
        try:
            return json.loads(repaired)
        except json.JSONDecodeError:
            raise first_error


def base_record(item: dict[str, Any], teacher_model: str, teacher_version: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "photoId": item["photoId"],
        "dataset": item.get("dataset"),
        "imagePath": item["teacherImagePath"],
        "studentPreviewPath": item.get("studentPreviewPath"),
        "teacherModel": teacher_model,
        "teacherVersion": teacher_version,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def image_size(path: str | Path) -> tuple[int, int]:
    try:
        with Image.open(path) as image:
            return image.size
    except Exception:
        return (1, 1)


def normalize_box_values(box: Any, width: int, height: int) -> list[float] | None:
    if not isinstance(box, list):
        return None
    if len(box) == 2:
        try:
            cx, cy = [float(v) for v in box]
        except (TypeError, ValueError):
            return None
        if 0.0 <= cx <= 1.0 and 0.0 <= cy <= 1.0:
            half_w = 0.06
            half_h = 0.06
            values = [cx - half_w, cy - half_h, cx + half_w, cy + half_h]
        else:
            half_w = max(24.0, width * 0.06)
            half_h = max(24.0, height * 0.06)
            values = [cx - half_w, cy - half_h, cx + half_w, cy + half_h]
    elif len(box) == 4:
        try:
            values = [float(v) for v in box]
        except (TypeError, ValueError):
            return None
    else:
        return None
    if all(0.0 <= value <= 1.0 for value in values):
        normalized = values
    elif all(0.0 <= value <= 100.0 for value in values):
        # Some VLMs follow "normalized" as percentages. Accept and convert.
        normalized = [value / 100.0 for value in values]
    else:
        normalized = [
            values[0] / max(1, width),
            values[1] / max(1, height),
            values[2] / max(1, width),
            values[3] / max(1, height),
        ]
    x1, y1, x2, y2 = [max(0.0, min(1.0, value)) for value in normalized]
    if x2 <= x1:
        x1, x2 = min(x1, x2), max(x1, x2)
        if x2 <= x1:
            x1, x2 = 0.0, 1.0
    if y2 <= y1:
        y1, y2 = min(y1, y2), max(y1, y2)
        if y2 <= y1:
            y1, y2 = 0.0, 1.0
    return [round(x1, 6), round(y1, 6), round(x2, 6), round(y2, 6)]


def normalize_record_boxes(record: dict[str, Any], image_path: str | Path) -> dict[str, Any]:
    width, height = image_size(image_path)
    out = dict(record)
    for list_field, box_field in (
        ("reasoningTrace", "region"),
        ("faceRegionVerdicts", "region"),
        ("regions", "box"),
    ):
        rows = out.get(list_field)
        if not isinstance(rows, list):
            continue
        fixed = []
        for row in rows:
            if not isinstance(row, dict):
                fixed.append(row)
                continue
            row = dict(row)
            if list_field == "regions" and "box" not in row and "region" in row:
                row["box"] = row["region"]
            if list_field == "regions" and "label" not in row:
                row["label"] = str(row.get("observation") or "region").strip() or "region"
            if list_field == "regions" and "confidence" not in row and "weight" in row:
                try:
                    row["confidence"] = max(0.0, min(1.0, float(row["weight"])))
                except (TypeError, ValueError):
                    pass
            box = normalize_box_values(row.get(box_field), width, height)
            if box is not None:
                row[box_field] = box
            fixed.append(row)
        out[list_field] = fixed
    return out


def heuristic_record(item: dict[str, Any], *, flat_scalar: bool) -> dict[str, Any]:
    image_path = Path(item["teacherImagePath"])
    try:
        image = Image.open(image_path).convert("RGB")
        width, height = image.size
        stat = ImageStat.Stat(image.resize((64, 64)))
        luma = sum(stat.mean) / (3 * 255.0)
        contrast = min(1.0, sum(stat.stddev) / (3 * 64.0))
    except Exception:
        width, height = 1, 1
        luma, contrast = 0.5, 0.2

    aspect = width / max(1, height)
    scenic = 0.65 if aspect > 1.25 else 0.45
    keep = max(0.05, min(0.95, 0.32 + contrast * 0.35 + scenic * 0.18 + (1 - abs(luma - 0.52)) * 0.12))
    scene_type = "landscape" if aspect > 1.35 else "environmental_portrait"
    record = {
        **base_record(item, "heuristic-smoke-not-for-training", "local-smoke"),
        "sceneType": scene_type,
        "sceneConfidence": 0.35,
        "subjectType": "unknown",
        "subjectConfidence": 0.25,
        "hasRealHumanFace": False,
        "faceValidityScore": 0.2,
        "falseFaceRisk": 0.1,
        "semanticKeepScore": keep,
        "compositionScore": min(0.95, 0.4 + scenic * 0.35),
        "momentScore": 0.35,
        "lightingMoodScore": max(0.05, min(0.95, 1 - abs(luma - 0.5))),
        "storytellingScore": 0.35,
        "scenicValueScore": scenic,
        "technicalVisibleIssueScore": 0.25 if contrast < 0.18 else 0.12,
        "emptyOrFillerScore": 0.55 if keep < 0.45 else 0.22,
        "duplicateRepresentativeHint": "unknown",
        "keepReasons": ["heuristic smoke estimate; not for training"],
        "rejectReasons": [],
        "regions": [{"label": "whole_frame", "box": [0.0, 0.0, 1.0, 1.0], "confidence": 0.25}],
        "uncertain": ["heuristic_backend"],
    }
    if not flat_scalar:
        record["reasoningTrace"] = [{
            "region": [0.0, 0.0, 1.0, 1.0],
            "observation": "whole-frame color and contrast smoke estimate",
            "supportsKeep": keep >= 0.5,
            "weight": 1.0,
        }]
        record["faceRegionVerdicts"] = []
    return normalize_record(record, flat_scalar=flat_scalar)


class QwenTeacher:
    def __init__(self, model_id: str, cache_dir: str | None = None):
        import torch
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

        kwargs = {"torch_dtype": torch.bfloat16, "device_map": "auto"}
        if cache_dir:
            kwargs["cache_dir"] = cache_dir
        self.model = Qwen2_5_VLForConditionalGeneration.from_pretrained(model_id, **kwargs)
        self.processor = AutoProcessor.from_pretrained(model_id, cache_dir=cache_dir, use_fast=False)
        self.model_id = model_id

    def annotate(
        self,
        item: dict[str, Any],
        *,
        flat_scalar: bool,
        max_new_tokens: int,
        raw_dir: Path | None = None,
    ) -> dict[str, Any]:
        prompt = PROMPT_FLAT if flat_scalar else PROMPT_GROUNDED
        image_path = item["teacherImagePath"]
        messages = [{
            "role": "user",
            "content": [
                {"type": "image", "image": image_path},
                {"type": "text", "text": prompt},
            ],
        }]

        try:
            from qwen_vl_utils import process_vision_info
            image_inputs, video_inputs = process_vision_info(messages)
            text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = self.processor(
                text=[text],
                images=image_inputs,
                videos=video_inputs,
                padding=True,
                return_tensors="pt",
            )
        except Exception:
            # Fallback for processor builds that accept PIL images directly.
            image = Image.open(image_path).convert("RGB")
            text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = self.processor(text=[text], images=[image], padding=True, return_tensors="pt")

        inputs = inputs.to(self.model.device)
        generated = self.model.generate(**inputs, max_new_tokens=max_new_tokens)
        generated = generated[:, inputs.input_ids.shape[1]:]
        text = self.processor.batch_decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
        if raw_dir:
            raw_dir.mkdir(parents=True, exist_ok=True)
            dataset = str(item.get("dataset") or "unknown")
            photo_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(item.get("photoId") or "unknown"))
            mode = "flat" if flat_scalar else "grounded"
            (raw_dir / f"{dataset}__{photo_id}__{mode}.txt").write_text(text, encoding="utf-8")
        payload = extract_json(text)
        # The VLM may hallucinate metadata fields; runner-owned provenance wins.
        payload = {**payload, **base_record(item, self.model_id, self.model_id)}
        payload = normalize_record_boxes(payload, image_path)
        return normalize_record(payload, flat_scalar=flat_scalar)


def make_teacher(args):
    if args.backend == "heuristic":
        return None
    if args.backend == "qwen2_5_vl":
        return QwenTeacher(args.model, cache_dir=args.cache)
    raise ValueError(f"unsupported backend: {args.backend}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--backend", choices=["qwen2_5_vl", "heuristic"], default="qwen2_5_vl")
    parser.add_argument("--model", default="Qwen/Qwen2.5-VL-7B-Instruct")
    parser.add_argument("--cache", default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--flat-scalar", action="store_true")
    parser.add_argument("--max-new-tokens", type=int, default=1600)
    parser.add_argument("--failures", type=Path, default=None)
    parser.add_argument("--summary", type=Path, default=None)
    parser.add_argument("--raw-dir", type=Path, default=None)
    parser.add_argument("--allow-preview-fallback", action="store_true")
    args = parser.parse_args()

    items = read_json(args.input)
    if args.limit:
        items = items[:args.limit]
    items = [item for item in items if item.get("teacherImagePath")]
    preview_fallback_items = [item for item in items if item.get("teacherImageIsPreviewFallback")]
    if preview_fallback_items and not args.allow_preview_fallback:
        examples = ", ".join(
            f"{item.get('dataset')}::{item.get('photoId')}" for item in preview_fallback_items[:10]
        )
        raise SystemExit(
            "Refusing to run Semantic Teacher on student preview fallback inputs. "
            f"Found {len(preview_fallback_items)} preview-backed items, examples: {examples}. "
            "Prepare high-resolution teacher JPEGs or pass --allow-preview-fallback for explicit smoke-only runs."
        )
    done = read_done(args.out) if args.resume else set()
    teacher = make_teacher(args)
    failures = []
    written = 0
    started = time.time()
    current_index = 0
    current_key: str | None = None
    interrupted_reason: str | None = None

    def persist_summary() -> dict[str, Any]:
        success_lines = len(done) + written
        summary = build_run_summary(
            args=args,
            total_items=len(items),
            preview_fallback_items=preview_fallback_items,
            started=started,
            success_lines=success_lines,
            written_this_run=written,
            failure_count=len(failures),
            current_index=current_index,
            current_key=current_key,
            interrupted_reason=interrupted_reason,
        )
        write_run_summary(args.summary, summary)
        return summary

    def handle_signal(signum, _frame):
        nonlocal interrupted_reason
        interrupted_reason = f"signal:{signum}"
        persist_summary()
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        for index, item in enumerate(items, 1):
            current_index = index
            key = f"{item.get('dataset')}::{item.get('photoId')}"
            current_key = key
            if key in done:
                continue
            try:
                if args.backend == "heuristic":
                    record = heuristic_record(item, flat_scalar=args.flat_scalar)
                else:
                    record = teacher.annotate(
                        item,
                        flat_scalar=args.flat_scalar,
                        max_new_tokens=args.max_new_tokens,
                        raw_dir=args.raw_dir,
                    )
                errors = validate_record(record, allow_flat_scalar=args.flat_scalar)
                if errors:
                    raise ValueError("; ".join(errors[:8]))
                append_jsonl(args.out, [record])
                written += 1
                if written % 10 == 0:
                    persist_summary()
                    print(f"[semantic-teacher] written={written} index={index}/{len(items)} elapsed={time.time()-started:.1f}s", flush=True)
            except Exception as error:
                row = {
                    "dataset": item.get("dataset"),
                    "photoId": item.get("photoId"),
                    "teacherImagePath": item.get("teacherImagePath"),
                    "error": str(error),
                }
                failures.append(row)
                if len(failures) % 10 == 0:
                    persist_summary()
                print(f"[semantic-teacher][warn] {row}", flush=True)
    except KeyboardInterrupt:
        interrupted_reason = interrupted_reason or "keyboard_interrupt"
        print("[semantic-teacher][warn] interrupted; partial summary flushed", flush=True)
    finally:
        summary = persist_summary()

    failure_path = args.failures or args.out.with_suffix(".failures.csv")
    if failures:
        failure_path.parent.mkdir(parents=True, exist_ok=True)
        with failure_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["dataset", "photoId", "teacherImagePath", "error"])
            writer.writeheader()
            writer.writerows(failures)
    elif failure_path.exists():
        failure_path.unlink()

    if failures:
        summary = persist_summary()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if interrupted_reason:
        return 130
    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
