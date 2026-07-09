#!/usr/bin/env python
"""Build MUSIQ/CLIP/DINOv2 teacher features for Semantic Student training.

Outputs NPZ files compatible with train_distill_backbone.py:
  stems, musiq_tech, musiq_aes, clip[512], dino[768]

The script intentionally fails when DINO is missing unless --smoke-fake-features
is set. Fake features are for plumbing tests only and must not be used for
training or reports.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageFile, ImageOps

ImageFile.LOAD_TRUNCATED_IMAGES = True


def image_paths(preview_dir: Path, limit: int | None = None) -> list[Path]:
    paths = sorted([p for p in preview_dir.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png"}])
    return paths[:limit] if limit else paths


def load_rgb(path: Path) -> Image.Image:
    return ImageOps.exif_transpose(Image.open(path)).convert("RGB")


def resized_musiq_path(path: Path, tmp_dir: Path, max_edge: int) -> Path:
    """Return a MUSIQ-safe JPEG path without mutating the source image."""
    if max_edge <= 0:
        return path
    with Image.open(path) as raw:
        img = ImageOps.exif_transpose(raw).convert("RGB")
        width, height = img.size
        if max(width, height) <= max_edge:
            return path
        digest = hashlib.sha1(str(path.resolve()).encode("utf-8")).hexdigest()[:12]
        out = tmp_dir / f"{path.stem}-{digest}-edge{max_edge}.jpg"
        if out.exists():
            return out
        tmp_dir.mkdir(parents=True, exist_ok=True)
        img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        img.save(out, format="JPEG", quality=92, subsampling=1)
        return out


def prepare_musiq_inputs(paths: list[Path], tmp_dir: Path, max_edge: int) -> list[Path]:
    prepared = []
    for idx, path in enumerate(paths, start=1):
        prepared.append(resized_musiq_path(path, tmp_dir, max_edge))
        if idx % 200 == 0:
            print(f"[features] musiq resized inputs {idx}/{len(paths)}", flush=True)
    return prepared


def fake_features(paths: list[Path]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(42)
    n = len(paths)
    return (
        rng.uniform(35, 85, size=n).astype("float32"),
        rng.uniform(35, 85, size=n).astype("float32"),
        rng.normal(0, 1, size=(n, 512)).astype("float32"),
        rng.normal(0, 1, size=(n, 768)).astype("float32"),
    )


class ClipExtractor:
    def __init__(self, device: str, cache_dir: str | None):
        from transformers import CLIPModel, CLIPProcessor

        model_id = "openai/clip-vit-base-patch32"
        self.processor = CLIPProcessor.from_pretrained(model_id, cache_dir=cache_dir)
        self.model = CLIPModel.from_pretrained(model_id, cache_dir=cache_dir).to(device).eval()
        self.device = device

    @torch.no_grad()
    def encode(self, images: list[Image.Image]) -> np.ndarray:
        inputs = self.processor(images=images, return_tensors="pt").to(self.device)
        feats = self.model.get_image_features(**inputs)
        feats = torch.nn.functional.normalize(feats, dim=-1)
        return feats.cpu().float().numpy().astype("float32")


class DinoExtractor:
    def __init__(self, device: str, cache_dir: str | None):
        if cache_dir:
            torch.hub.set_dir(str(Path(cache_dir) / "torchhub"))
        self.model = torch.hub.load("facebookresearch/dinov2", "dinov2_vitb14").to(device).eval()
        self.device = device
        self.mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1).to(device)
        self.std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1).to(device)

    @torch.no_grad()
    def encode(self, images: list[Image.Image]) -> np.ndarray:
        tensors = []
        for img in images:
            img = img.resize((518, 518), Image.BICUBIC)
            arr = np.asarray(img, dtype=np.float32) / 255.0
            tensors.append(torch.from_numpy(arr).permute(2, 0, 1))
        batch = torch.stack(tensors).to(self.device)
        batch = (batch - self.mean) / self.std
        feats = self.model(batch)
        feats = torch.nn.functional.normalize(feats, dim=-1)
        out = feats.cpu().float().numpy().astype("float32")
        if out.shape[1] != 768:
            raise RuntimeError(f"DINOv2 output must be 768 dims, got {out.shape}")
        return out


class MusiqExtractor:
    def __init__(self, device: str):
        import pyiqa

        self.tech_name, self.tech = self._create_first_available(
            pyiqa,
            ["musiq", "musiq-spaq", "musiq-paq2piq", "nima-koniq"],
            device,
        )
        self.aes_name, self.aes = self._create_first_available(
            pyiqa,
            ["musiq-ava", "nima-vgg16-ava", "nima"],
            device,
        )

    @staticmethod
    def _create_first_available(pyiqa: Any, names: list[str], device: str) -> tuple[str, Any]:
        errors: list[str] = []
        for name in names:
            try:
                return name, pyiqa.create_metric(name, device=device)
            except Exception as exc:
                errors.append(f"{name}: {type(exc).__name__}: {exc}")
        raise RuntimeError("No compatible IQA metric found. Tried: " + " | ".join(errors))

    @torch.no_grad()
    def score(self, paths: list[Path]) -> tuple[np.ndarray, np.ndarray]:
        tech, aes = [], []
        for path in paths:
            tech.append(float(self.tech(str(path)).detach().cpu().reshape(-1)[0]))
            aes.append(float(self.aes(str(path)).detach().cpu().reshape(-1)[0]))
        return np.array(tech, dtype="float32"), np.array(aes, dtype="float32")


def batches(items: list[Any], batch_size: int):
    for start in range(0, len(items), batch_size):
        yield items[start:start + batch_size]


def build_for_dir(args, dataset: str, preview_dir: Path, out_path: Path) -> dict[str, Any]:
    paths = image_paths(preview_dir, args.limit)
    stems = np.array([p.stem for p in paths])
    musiq_metrics = {"technical": "fake", "aesthetic": "fake"}
    if args.smoke_fake_features:
        musiq_tech, musiq_aes, clip, dino = fake_features(paths)
    else:
        device = "cuda" if torch.cuda.is_available() and not args.cpu else "cpu"
        clip_extractor = ClipExtractor(device, args.cache)
        dino_extractor = DinoExtractor(device, args.cache)

        clip_rows, dino_rows = [], []
        for batch_paths in batches(paths, args.batch):
            images = [load_rgb(path) for path in batch_paths]
            clip_rows.append(clip_extractor.encode(images))
            dino_rows.append(dino_extractor.encode(images))
            print(f"[features] {dataset} embedding {sum(len(x) for x in clip_rows)}/{len(paths)}", flush=True)
        clip = np.concatenate(clip_rows, axis=0).astype("float32")
        dino = np.concatenate(dino_rows, axis=0).astype("float32")
        del clip_extractor
        del dino_extractor
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        musiq_tmp = Path(args.musiq_tmp_dir) if args.musiq_tmp_dir else Path(os.environ.get("TMPDIR", str(args.out_dir / "_tmp"))) / "musiq-inputs" / dataset
        musiq_paths = prepare_musiq_inputs(paths, musiq_tmp, args.musiq_max_edge)
        musiq_extractor = MusiqExtractor(device)
        musiq_metrics = {
            "technical": musiq_extractor.tech_name,
            "aesthetic": musiq_extractor.aes_name,
            "maxEdge": args.musiq_max_edge,
            "inputDir": str(musiq_tmp),
        }
        musiq_tech, musiq_aes = musiq_extractor.score(musiq_paths)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out_path, stems=stems, musiq_tech=musiq_tech, musiq_aes=musiq_aes, clip=clip, dino=dino)
    return {
        "dataset": dataset,
        "previewDir": str(preview_dir),
        "out": str(out_path),
        "count": len(paths),
        "clipShape": list(clip.shape),
        "dinoShape": list(dino.shape),
        "musiqMetrics": musiq_metrics,
        "fake": args.smoke_fake_features,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera-previews", type=Path, required=True)
    parser.add_argument("--audit-previews", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--cache", default=None)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument("--smoke-fake-features", action="store_true")
    parser.add_argument("--musiq-max-edge", type=int, default=1024)
    parser.add_argument("--musiq-tmp-dir", type=Path, default=None)
    args = parser.parse_args()
    reports = [
        build_for_dir(args, "camera", args.camera_previews, args.out_dir / "teacher-camera.npz"),
        build_for_dir(args, "audit3groups", args.audit_previews, args.out_dir / "teacher-audit3groups.npz"),
    ]
    payload = {
        "schemaVersion": "framecull-quality-teacher-features-v1",
        "reports": reports,
        "dinoEnabled": True,
        "fake": args.smoke_fake_features,
    }
    (args.out_dir / "teacher-feature-summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if args.smoke_fake_features:
        print("[warn] smoke fake features are not valid for training", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
