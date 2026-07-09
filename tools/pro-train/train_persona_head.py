#!/usr/bin/env python
"""Stage 2: train a tiny persona pick head on top of a distilled student.

The distilled backbone and teacher heads are frozen. This script trains only a
small binary/ranking head that learns "usable photo" preference from ratings.

Label policy for this run is source-specific:
  camera and future non-audit datasets: rating >= 1 -> positive / usable
  audit3groups / G-drive validation: rating >= 3 -> positive / selected
  rating below the source threshold, missing, or 0 -> negative / rejected

Ratings are targets and sample weights only. Ratings, file names, paths, and
dataset source names are never used as model inputs.
"""
import argparse
import csv
import hashlib
import json
import os
import time
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn as nn
from PIL import Image, ImageFile
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score, average_precision_score
from torch.utils.data import DataLoader, Dataset

from train_distill_backbone import IMAGENET_MEAN, IMAGENET_STD, MultiHeadStudent
from train_semantic_student import SemanticStudent

ImageFile.LOAD_TRUNCATED_IMAGES = True

LAB = "/data/FrameCullModelLab"
CAMERA_PREVIEWS = f"{LAB}/incoming/camera-previews-384"
CAMERA_LABELS = f"{LAB}/incoming/camera-labels/camera-labels-final.json"
FIVE_MOUNTAIN_PREVIEWS = f"{LAB}/incoming/five-mountain-previews-384"
FIVE_MOUNTAIN_LABELS = f"{LAB}/incoming/five-mountain-labels/five-mountain-labels.json"
AUDIT_PREVIEWS = f"{LAB}/incoming/raw-audit-previews"
AUDIT_LABELS = f"{LAB}/incoming/raw-audit-previews/labels.json"
LABEL_POLICIES = {
    "camera": {
        "positive_threshold": 1,
        "description": "rating>=1 positive; rating==0 or missing negative",
    },
    "five_mountain": {
        "positive_threshold": 1,
        "description": "rating>=1 positive; rating==0 or missing negative",
    },
    "audit3groups": {
        "positive_threshold": 3,
        "description": "rating>=3 positive; rating<3 or missing negative",
    },
}


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class PersonaItem:
    stem: str
    path: str
    source: str
    rating: int
    label: int
    weight: float
    positive_threshold: int


class ImageDataset(Dataset):
    def __init__(self, items, input_size=384):
        self.items = items
        self.input_size = input_size

    def __len__(self):
        return len(self.items)

    def _load(self, path):
        try:
            img = Image.open(path).convert("RGB")
            img = img.resize((self.input_size, self.input_size), Image.BILINEAR)
            arr = np.asarray(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).permute(2, 0, 1)
        except Exception as e:
            print(f"[warn] load fail {path}: {e}", flush=True)
            return torch.full((3, self.input_size, self.input_size), 0.5)

    def __getitem__(self, idx):
        it = self.items[idx]
        return (
            self._load(it.path),
            torch.tensor(it.label, dtype=torch.float32),
            torch.tensor(it.weight, dtype=torch.float32),
            torch.tensor(it.rating, dtype=torch.float32),
            idx,
        )


class PersonaHead(nn.Module):
    def __init__(self, feat_dim, hidden=256):
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(feat_dim),
            nn.Linear(feat_dim, hidden),
            nn.GELU(),
            nn.Dropout(0.15),
            nn.Linear(hidden, 1),
        )

    def forward(self, feat):
        return self.net(feat).squeeze(-1)


def infer_head_hidden(state_dict):
    hidden = state_dict.get("net.1.weight")
    if hidden is None or hidden.ndim != 2:
        raise RuntimeError("persona head checkpoint missing net.1.weight")
    return int(hidden.shape[0])


def load_student_from_checkpoint(ckpt):
    schema = str(ckpt.get("schema") or "")
    if schema == "framecull-pro-semantic-student-v2":
        student = SemanticStudent(
            ckpt["backbone"],
            clip_dim=int(ckpt.get("clip_dim") or 512),
            dino_dim=int(ckpt.get("dino_dim") or 768),
            scene_count=len(ckpt.get("scene_labels") or []),
            input_size=int(ckpt["input_size"]),
            pretrained=False,
        )
        missing, unexpected = student.load_state_dict(ckpt["model"], strict=False)
        if missing or unexpected:
            print(
                f"[warn] semantic student checkpoint/head mismatch: "
                f"missing={list(missing)} unexpected={list(unexpected)}. "
                "Persona training uses the frozen backbone features only.",
                flush=True,
            )
        return student, {
            "studentType": "semantic-student-v2",
            "studentSchema": schema,
            "clipDim": int(ckpt.get("clip_dim") or 512),
            "dinoDim": int(ckpt.get("dino_dim") or 768),
            "sceneLabels": list(ckpt.get("scene_labels") or []),
        }

    student = MultiHeadStudent(
        ckpt["backbone"],
        clip_dim=int(ckpt.get("clip_dim") or 512),
        dino_dim=int(ckpt.get("dino_dim") or 0),
        pretrained=False,
        input_size=int(ckpt["input_size"]),
    )
    student.load_state_dict(ckpt["model"])
    return student, {
        "studentType": "distill-backbone-v1",
        "studentSchema": schema or "framecull-pro-distill-backbone-v1",
        "clipDim": int(ckpt.get("clip_dim") or 512),
        "dinoDim": int(ckpt.get("dino_dim") or 0),
        "sceneLabels": [],
    }


def read_record_label_items(source, preview_dir, labels_path, positive_threshold=None):
    data = json.load(open(labels_path, encoding="utf-8"))
    records = data.get("records", {})
    items = []
    threshold = int(positive_threshold or LABEL_POLICIES[source]["positive_threshold"])
    for stem, rec in records.items():
        p = os.path.join(preview_dir, f"{stem}.jpg")
        if not os.path.exists(p):
            continue
        rating = int(rec.get("rating") or 0)
        label = 1 if rating >= threshold else 0
        weight = rating_weight(rating)
        items.append(PersonaItem(stem, p, source, rating, label, weight, threshold))
    return items


def read_camera_items():
    return read_record_label_items("camera", CAMERA_PREVIEWS, CAMERA_LABELS)


def read_five_mountain_items():
    return read_record_label_items("five_mountain", FIVE_MOUNTAIN_PREVIEWS, FIVE_MOUNTAIN_LABELS)


def parse_camera_like_dataset(spec):
    parts = spec.split(":", 3)
    if len(parts) not in (3, 4):
        raise ValueError(
            "--camera-like-dataset must be source:preview_dir:labels_json[:positive_threshold]"
        )
    source, preview_dir, labels_path = parts[:3]
    threshold = int(parts[3]) if len(parts) == 4 and parts[3] else 1
    if source in LABEL_POLICIES:
        raise ValueError(f"source already exists: {source}")
    LABEL_POLICIES[source] = {
        "positive_threshold": threshold,
        "description": f"rating>={threshold} positive; rating below threshold or missing negative",
    }
    return read_record_label_items(source, preview_dir, labels_path, threshold)


def read_audit_items():
    data = json.load(open(AUDIT_LABELS, encoding="utf-8"))
    labels = data.get("labels", {})
    items = []
    threshold = LABEL_POLICIES["audit3groups"]["positive_threshold"]
    for name in os.listdir(AUDIT_PREVIEWS):
        if not name.lower().endswith(".jpg"):
            continue
        stem = os.path.splitext(name)[0]
        rating = int(labels.get(stem, 0) or 0)
        label = 1 if rating >= threshold else 0
        weight = rating_weight(rating)
        items.append(PersonaItem(stem, os.path.join(AUDIT_PREVIEWS, name), "audit3groups", rating, label, weight, threshold))
    return items


def stem_key(value):
    if value is None:
        return ""
    text = str(value).strip().strip('"').strip("'")
    if not text:
        return ""
    stem = os.path.splitext(os.path.basename(text))[0].lower()
    while True:
        inner = os.path.splitext(stem)[0].lower()
        if inner == stem:
            break
        stem = inner
    return stem


def read_excluded_photoids(path):
    if not path:
        return set()
    excluded = set()
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            for field in ("photoId", "absolutePath", "imagePath", "fileName"):
                key = stem_key(row.get(field))
                if key:
                    excluded.add(key)
    return excluded


def apply_exclusions(items, excluded):
    if not excluded:
        return items, []
    kept = []
    removed = []
    for item in items:
        key = stem_key(item.stem)
        path_key = stem_key(item.path)
        if key in excluded or path_key in excluded:
            removed.append(item)
        else:
            kept.append(item)
    return kept, removed


def rating_weight(rating):
    if rating <= 0:
        return 1.0
    # Keep 1-star as usable, but let stronger manual picks influence ranking more.
    return {1: 1.0, 2: 1.15, 3: 1.35, 4: 1.75, 5: 2.25}.get(int(rating), 1.0)


def apply_source_balanced_train_weights(items):
    source_totals = {}
    for item in items:
        source_totals[item.source] = source_totals.get(item.source, 0.0) + float(item.weight)
    if not source_totals:
        return {}
    target = sum(source_totals.values()) / len(source_totals)
    multipliers = {
        source: (target / total if total > 0 else 1.0)
        for source, total in source_totals.items()
    }
    for item in items:
        item.weight *= multipliers.get(item.source, 1.0)
    return multipliers


def split_items(items, mode, seed, holdout_source=None):
    if mode == "source-holdout":
        if holdout_source:
            train = [x for x in items if x.source != holdout_source]
            val = [x for x in items if x.source == holdout_source]
        else:
            train = [x for x in items if x.source == "camera"]
            val = [x for x in items if x.source != "camera"]
        return train, val
    rng = np.random.default_rng(seed)
    by_source = {}
    for item in items:
        by_source.setdefault(item.source, []).append(item)
    train, val = [], []
    for source, group in by_source.items():
        pos = [x for x in group if x.label == 1]
        neg = [x for x in group if x.label == 0]
        for bucket in (pos, neg):
            idx = np.arange(len(bucket))
            rng.shuffle(idx)
            n_val = max(1, int(len(bucket) * 0.2)) if len(bucket) > 5 else 0
            val_ids = set(idx[:n_val].tolist())
            for i, item in enumerate(bucket):
                (val if i in val_ids else train).append(item)
    return train, val


@torch.no_grad()
def extract_features(student, items, batch, workers, device, input_size):
    ds = ImageDataset(items, input_size)
    dl = DataLoader(ds, batch_size=batch, shuffle=False, num_workers=workers, pin_memory=True)
    mean = IMAGENET_MEAN.to(device)
    std = IMAGENET_STD.to(device)
    feats, labels, weights, ratings, indices = [], [], [], [], []
    student.eval()
    for step, (px, y, w, r, idx) in enumerate(dl):
        px = ((px.to(device, non_blocking=True) - mean) / std)
        feat = student.backbone(px)
        feats.append(feat.cpu())
        labels.append(y)
        weights.append(w)
        ratings.append(r)
        indices.append(idx)
        if (step + 1) % 20 == 0:
            print(f"[features] {(step + 1) * batch}/{len(items)}", flush=True)
    return (
        torch.cat(feats).float(),
        torch.cat(labels).float(),
        torch.cat(weights).float(),
        torch.cat(ratings).float(),
        torch.cat(indices).long(),
    )


def train_head(feat_train, y_train, w_train, feat_val, y_val, w_val, feat_dim, args, device):
    head = PersonaHead(feat_dim, args.hidden).to(device)
    opt = torch.optim.AdamW(head.parameters(), lr=args.lr, weight_decay=args.wd)
    # Balance positive/negative frequency, then multiply by rating strength.
    pos = float(y_train.sum().item())
    neg = float((1 - y_train).sum().item())
    pos_weight = torch.tensor([max(1.0, neg / max(1.0, pos))], device=device)
    bce = nn.BCEWithLogitsLoss(reduction="none", pos_weight=pos_weight)
    best_auc = -1.0
    best_state = None
    n = feat_train.shape[0]
    rng = np.random.default_rng(args.seed)
    for ep in range(args.epochs):
        order = rng.permutation(n)
        head.train()
        losses = []
        for start in range(0, n, args.batch):
            idx = torch.tensor(order[start:start + args.batch], dtype=torch.long)
            f = feat_train[idx].to(device)
            y = y_train[idx].to(device)
            w = w_train[idx].to(device)
            opt.zero_grad(set_to_none=True)
            logits = head(f)
            loss = (bce(logits, y) * w).mean()
            loss.backward()
            opt.step()
            losses.append(float(loss.item()))
        metrics = evaluate_head(head, feat_val, y_val, w_val, device)
        print(f"[persona] ep{ep} loss={np.mean(losses):.4f} val={metrics}", flush=True)
        if metrics["auc"] > best_auc:
            best_auc = metrics["auc"]
            best_state = {k: v.cpu() for k, v in head.state_dict().items()}
    head.load_state_dict(best_state)
    return head, evaluate_head(head, feat_val, y_val, w_val, device)


@torch.no_grad()
def evaluate_head(head, feat, y, w, device):
    head.eval()
    logits = []
    for start in range(0, feat.shape[0], 512):
        logits.append(head(feat[start:start + 512].to(device)).cpu())
    logits = torch.cat(logits).numpy()
    probs = 1.0 / (1.0 + np.exp(-logits))
    yy = y.numpy()
    if len(np.unique(yy)) < 2:
        auc = 0.0
        ap = 0.0
    else:
        auc = float(roc_auc_score(yy, probs))
        ap = float(average_precision_score(yy, probs))
    return {
        "auc": auc,
        "ap": ap,
        "mean_pos_score": float(probs[yy == 1].mean()) if (yy == 1).any() else 0.0,
        "mean_neg_score": float(probs[yy == 0].mean()) if (yy == 0).any() else 0.0,
    }


@torch.no_grad()
def predict_all(head, feat, device):
    out = []
    head.eval()
    for start in range(0, feat.shape[0], 512):
        logits = head(feat[start:start + 512].to(device)).cpu().numpy()
        out.append(1.0 / (1.0 + np.exp(-logits)))
    return np.concatenate(out)


def ratio_metrics(items, scores, ratios):
    rows = []
    y = np.array([it.label for it in items])
    ratings = np.array([it.rating for it in items])
    sources = sorted({it.source for it in items})
    order = np.argsort(-scores)
    total_pos = int(y.sum())
    total_neg = int((1 - y).sum())
    for ratio in ratios:
        k = max(1, int(round(len(items) * ratio)))
        picked = order[:k]
        picked_pos = int(y[picked].sum())
        picked_neg = int((1 - y[picked]).sum())
        row = {
            "scope": "all",
            "positiveThreshold": "source-specific",
            "ratio": ratio,
            "selected": k,
            "positiveRecall": picked_pos / max(1, total_pos),
            "negativePickedRate": picked_neg / max(1, total_neg),
            "precision": picked_pos / max(1, k),
            "pickedPositive": picked_pos,
            "totalPositive": total_pos,
            "pickedNegative": picked_neg,
            "totalNegative": total_neg,
            "rating4_5Coverage": int(((ratings[picked] >= 4)).sum()) / max(1, int((ratings >= 4).sum())),
        }
        rows.append(row)
        for source in sources:
            mask = np.array([it.source == source for it in items])
            source_indices = np.where(mask)[0]
            source_picked = np.array([i for i in picked if mask[i]], dtype=int)
            if len(source_indices) == 0:
                continue
            sy = y[source_indices]
            sr = ratings[source_indices]
            rows.append({
                "scope": source,
                "positiveThreshold": int(LABEL_POLICIES[source]["positive_threshold"]),
                "ratio": ratio,
                "selected": int(len(source_picked)),
                "positiveRecall": int(y[source_picked].sum()) / max(1, int(sy.sum())),
                "negativePickedRate": int((1 - y[source_picked]).sum()) / max(1, int((1 - sy).sum())),
                "precision": int(y[source_picked].sum()) / max(1, len(source_picked)),
                "pickedPositive": int(y[source_picked].sum()),
                "totalPositive": int(sy.sum()),
                "pickedNegative": int((1 - y[source_picked]).sum()),
                "totalNegative": int((1 - sy).sum()),
                "rating4_5Coverage": int((ratings[source_picked] >= 4).sum()) / max(1, int((sr >= 4).sum())),
            })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--student", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--split", choices=["stratified", "source-holdout"], default="stratified")
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--image-batch", type=int, default=64)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--wd", type=float, default=0.01)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--ratios", default="0.38,0.45,0.50,0.60")
    ap.add_argument("--include-five-mountain", action="store_true",
                    help="Include /data/FrameCullModelLab/incoming/five-mountain-* as a camera-like outdoor dataset.")
    ap.add_argument("--camera-like-dataset", action="append", default=[],
                    help="Additional source:preview_dir:labels_json[:positive_threshold] dataset. "
                         "Records format must match camera-labels-final.json.")
    ap.add_argument("--holdout-source", default=None,
                    help="With --split source-holdout, validate only this source and train on all other sources.")
    ap.add_argument("--source-balanced-weights", action="store_true",
                    help="Scale training sample weights so each source contributes equal total weight.")
    ap.add_argument("--exclude-photoids-csv", default="",
                    help="CSV with photoId/absolutePath rows to exclude from persona training, e.g. the v13 independent holdout.")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[env] device={device} gpu={torch.cuda.get_device_name(0) if device=='cuda' else 'cpu'}", flush=True)
    ckpt = torch.load(args.student, map_location="cpu")
    student, student_meta = load_student_from_checkpoint(ckpt)
    student.to(device)
    for p in student.parameters():
        p.requires_grad_(False)

    items = read_camera_items()
    if args.include_five_mountain:
        items += read_five_mountain_items()
    for spec in args.camera_like_dataset:
        items += parse_camera_like_dataset(spec)
    items += read_audit_items()
    if args.limit:
        items = items[:args.limit]
    excluded_photoids = read_excluded_photoids(args.exclude_photoids_csv)
    items, excluded_items = apply_exclusions(items, excluded_photoids)
    dist = {}
    for it in items:
        dist[(it.source, it.rating)] = dist.get((it.source, it.rating), 0) + 1
    print(f"[data] total={len(items)} excluded={len(excluded_items)} dist={dist}", flush=True)

    train_items, val_items = split_items(items, args.split, args.seed, args.holdout_source)
    source_weight_multipliers = (
        apply_source_balanced_train_weights(train_items)
        if args.source_balanced_weights else {}
    )
    if source_weight_multipliers:
        print(f"[data] source-balanced train multipliers={source_weight_multipliers}", flush=True)
    print(f"[split] mode={args.split} train={len(train_items)} val={len(val_items)} "
          f"train_pos={sum(x.label for x in train_items)} val_pos={sum(x.label for x in val_items)}", flush=True)

    t0 = time.time()
    feat_train, y_train, w_train, _, _ = extract_features(student, train_items, args.image_batch, args.workers,
                                                          device, ckpt["input_size"])
    feat_val, y_val, w_val, _, _ = extract_features(student, val_items, args.image_batch, args.workers,
                                                    device, ckpt["input_size"])
    head, val_metrics = train_head(feat_train, y_train, w_train, feat_val, y_val, w_val,
                                   student.feat_dim, args, device)

    feat_all, y_all, w_all, ratings_all, _ = extract_features(student, items, args.image_batch, args.workers,
                                                              device, ckpt["input_size"])
    scores = predict_all(head, feat_all, device)
    all_metrics = evaluate_head(head, feat_all, y_all, w_all, device)
    srcc = float(spearmanr(scores, ratings_all.numpy()).statistic)
    ratios = [float(x) for x in args.ratios.split(",") if x.strip()]
    rows = ratio_metrics(items, scores, ratios)

    persona_state = head.state_dict()
    torch.save({
        "schema": "framecull-pro-persona-head-v2",
        "persona_head": persona_state,
        "persona_hidden": infer_head_hidden(persona_state),
        "backbone": ckpt["backbone"],
        "feat_dim": student.feat_dim,
        "input_size": ckpt["input_size"],
        "clip_dim": int(ckpt.get("clip_dim") or 512),
        "dino_dim": int(ckpt.get("dino_dim") or 0),
        "student_schema": student_meta["studentSchema"],
        "student_type": student_meta["studentType"],
        "scene_labels": student_meta["sceneLabels"],
        "label_policy": LABEL_POLICIES,
        "val_metrics": val_metrics,
        "all_metrics": all_metrics,
        "rating_srcc": srcc,
    }, os.path.join(args.out, "persona-head.pt"))
    with open(os.path.join(args.out, "metrics-by-ratio.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    summary = {
        "student": args.student,
        "studentSha256": file_sha256(args.student),
        "split": args.split,
        "labelPolicy": LABEL_POLICIES,
        "studentType": student_meta["studentType"],
        "studentSchema": student_meta["studentSchema"],
        "total": len(items),
        "positive": int(sum(x.label for x in items)),
        "negative": int(len(items) - sum(x.label for x in items)),
        "valMetrics": val_metrics,
        "allMetrics": all_metrics,
        "ratingSrcc": srcc,
        "sourceBalancedWeights": bool(args.source_balanced_weights),
        "trainSourceWeightMultipliers": source_weight_multipliers,
        "excludedPhotoidsCsv": args.exclude_photoids_csv or None,
        "excludedCount": len(excluded_items),
        "excludedExamples": [
            {"source": item.source, "stem": item.stem, "rating": item.rating}
            for item in excluded_items[:20]
        ],
        "elapsedS": time.time() - t0,
    }
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    with open(os.path.join(args.out, "predictions.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["source", "stem", "rating", "positiveThreshold", "label", "personaScore"])
        writer.writeheader()
        for it, score in zip(items, scores):
            writer.writerow({
                "source": it.source,
                "stem": it.stem,
                "rating": it.rating,
                "positiveThreshold": it.positive_threshold,
                "label": it.label,
                "personaScore": float(score),
            })
    print("==PERSONA_DONE==", json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
