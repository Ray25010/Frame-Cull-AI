#!/usr/bin/env python
"""阶段一:分头蒸馏 backbone(方案 B)。

共享 backbone(ConvNeXt-Tiny / DeiT-Tiny,384 输入)+ 多头:
  - technical head  -> 蒸馏 MUSIQ KonIQ 技术分 (musiq_tech)
  - aesthetic head  -> 蒸馏 MUSIQ AVA 美学分   (musiq_aes)
  - scene head      -> 蒸馏 CLIP 512 语义 embedding(余弦 + MSE)
  - dino head       -> 蒸馏 DINOv2 768 embedding(余弦 + MSE)

训练只用教师软标签(无人工星级),大未标注集 = 相机 + 原三组全部预览。
星级/路径/文件名绝不进特征或损失。

用法(smoke):
  python train_distill_backbone.py --backbone convnext_tiny --limit 256 \
      --epochs 1 --batch 32 --out <dir>/smoke
用法(全量后台):
  nohup python train_distill_backbone.py --backbone convnext_tiny \
      --epochs 30 --batch 64 --out <dir>/convnext > log 2>&1 &
"""
import argparse
import json
import os
import time
from dataclasses import dataclass, asdict

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from PIL import Image, ImageFile
import timm
from scipy.stats import spearmanr, pearsonr

# 容忍轻微截断的 JPEG(教师特征已成功读过这些图,训练端不应因 17 bytes 截断整轮崩溃)
ImageFile.LOAD_TRUNCATED_IMAGES = True


LAB = "/data/FrameCullModelLab"
TEACHER_DIR = f"{LAB}/features/teacher"
PREVIEW_DIRS = {
    "camera": f"{LAB}/incoming/camera-previews-384",
    "audit3groups": f"{LAB}/incoming/raw-audit-previews",
}
TEACHER_NPZ = {
    "camera": f"{TEACHER_DIR}/teacher-camera.npz",
    "audit3groups": f"{TEACHER_DIR}/teacher-audit3groups.npz",
}
IMAGENET_MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
IMAGENET_STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)


@dataclass
class Normalizer:
    """标准化教师标量,导出时写入 manifest 以便推理端反算。"""
    mean: float
    std: float

    def encode(self, x):
        return (x - self.mean) / (self.std + 1e-6)


class DistillDataset(Dataset):
    def __init__(self, items, input_size=384, augment=False):
        # items: list of dict(path, tech, aes, clip[512], dino[768])
        self.items = items
        self.input_size = input_size
        self.augment = augment

    def __len__(self):
        return len(self.items)

    def _load(self, path):
        try:
            img = Image.open(path).convert("RGB")
            img = img.resize((self.input_size, self.input_size), Image.BILINEAR)
            arr = np.asarray(img, dtype=np.float32) / 255.0  # HWC
            t = torch.from_numpy(arr).permute(2, 0, 1)       # CHW
            if t.shape != (3, self.input_size, self.input_size):
                raise ValueError(f"bad shape {tuple(t.shape)}")
            return t
        except Exception as e:  # 单图损坏不挂全批,返回中性灰图
            print(f"[warn] load fail {path}: {e}", flush=True)
            return torch.full((3, self.input_size, self.input_size), 0.5)

    def __getitem__(self, idx):
        it = self.items[idx]
        px = self._load(it["path"])
        if self.augment and torch.rand(1).item() < 0.5:
            px = torch.flip(px, dims=[2])  # 水平翻转,语义/美学不变
        return (
            px,
            torch.tensor(it["tech"], dtype=torch.float32),
            torch.tensor(it["aes"], dtype=torch.float32),
            torch.from_numpy(it["clip"]).float(),
            torch.from_numpy(it["dino"]).float(),
        )


class MultiHeadStudent(nn.Module):
    def __init__(self, backbone_name, clip_dim=512, dino_dim=0, pretrained=True, input_size=384):
        super().__init__()
        kw = dict(pretrained=pretrained, num_classes=0, global_pool="avg")
        # ViT 系需要 img_size 覆盖以插值位置编码
        if "deit" in backbone_name or "vit" in backbone_name:
            kw["img_size"] = input_size
        self.backbone = timm.create_model(backbone_name, **kw)
        feat = self.backbone.num_features
        self.feat_dim = feat

        def head(out):
            return nn.Sequential(
                nn.Linear(feat, 256), nn.GELU(), nn.Dropout(0.1), nn.Linear(256, out)
            )

        self.tech_head = head(1)
        self.aes_head = head(1)
        self.scene_head = head(clip_dim)
        self.dino_dim = int(dino_dim or 0)
        self.dino_head = head(self.dino_dim) if self.dino_dim > 0 else None

    def forward(self, x):
        f = self.backbone(x)
        outputs = (
            self.tech_head(f).squeeze(-1),
            self.aes_head(f).squeeze(-1),
            self.scene_head(f),
        )
        if self.dino_head is not None:
            return (*outputs, self.dino_head(f))
        return outputs


def build_items(limit=None, require_dino=True):
    items = []
    for tag, npz_path in TEACHER_NPZ.items():
        d = np.load(npz_path, allow_pickle=True)
        stems = d["stems"]
        clip = d["clip"]
        if require_dino and "dino" not in d.files:
            raise RuntimeError(f"{npz_path} is missing dino[768]; Phase 2.5 is incomplete")
        dino = d["dino"] if "dino" in d.files else np.zeros((len(stems), 0), dtype=np.float32)
        tech = d["musiq_tech"]
        aes = d["musiq_aes"]
        pdir = PREVIEW_DIRS[tag]
        miss = 0
        for i, stem in enumerate(stems):
            p = os.path.join(pdir, f"{stem}.jpg")
            if not os.path.exists(p):
                miss += 1
                continue
            items.append({
                "path": p,
                "tech": float(tech[i]),
                "aes": float(aes[i]),
                "clip": clip[i].astype(np.float32),
                "dino": dino[i].astype(np.float32),
                "source": tag,
            })
        print(f"[data] {tag}: {len(stems)} stems, miss={miss}", flush=True)
    if limit:
        items = items[:limit]
    return items


def split_items(items, val_frac=0.1, seed=42):
    rng = np.random.default_rng(seed)
    idx = np.arange(len(items))
    rng.shuffle(idx)
    n_val = int(len(items) * val_frac)
    val_idx = set(idx[:n_val].tolist())
    train = [items[i] for i in range(len(items)) if i not in val_idx]
    val = [items[i] for i in range(len(items)) if i in val_idx]
    return train, val


def cosine_loss(pred, target):
    pred = nn.functional.normalize(pred, dim=-1)
    target = nn.functional.normalize(target, dim=-1)
    return (1.0 - (pred * target).sum(-1)).mean()


@torch.no_grad()
def evaluate(model, loader, device, tech_norm, aes_norm):
    model.eval()
    pt, gt, pa, ga = [], [], [], []
    clip_cos = []
    dino_cos = []
    mean = IMAGENET_MEAN.to(device)
    std = IMAGENET_STD.to(device)
    for px, tech, aes, clip, dino in loader:
        px = ((px.to(device) - mean) / std)
        outputs = model(px)
        et, ea, ec = outputs[:3]
        pt.append(et.cpu().numpy())
        gt.append(tech_norm.encode(tech).numpy())
        pa.append(ea.cpu().numpy())
        ga.append(aes_norm.encode(aes).numpy())
        c1 = nn.functional.normalize(ec, dim=-1)
        c2 = nn.functional.normalize(clip.to(device), dim=-1)
        clip_cos.append((c1 * c2).sum(-1).cpu().numpy())
        if len(outputs) > 3 and dino.shape[-1] > 0:
            ed = outputs[3]
            d1 = nn.functional.normalize(ed, dim=-1)
            d2 = nn.functional.normalize(dino.to(device), dim=-1)
            dino_cos.append((d1 * d2).sum(-1).cpu().numpy())
    pt = np.concatenate(pt); gt = np.concatenate(gt)
    pa = np.concatenate(pa); ga = np.concatenate(ga)
    clip_cos = np.concatenate(clip_cos)
    dino_cos = np.concatenate(dino_cos) if dino_cos else np.array([0.0])

    def srcc_plcc(p, g):
        if len(p) < 3 or np.std(p) < 1e-8:
            return 0.0, 0.0
        return float(spearmanr(p, g).statistic), float(pearsonr(p, g)[0])

    ts, tp = srcc_plcc(pt, gt)
    as_, ap = srcc_plcc(pa, ga)
    return {
        "tech_srcc": ts, "tech_plcc": tp,
        "aes_srcc": as_, "aes_plcc": ap,
        "clip_cos_mean": float(clip_cos.mean()),
        "dino_cos_mean": float(dino_cos.mean()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backbone", default="convnext_tiny")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--wd", type=float, default=0.05)
    ap.add_argument("--input-size", type=int, default=384)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--w-tech", type=float, default=1.0)
    ap.add_argument("--w-aes", type=float, default=1.0)
    ap.add_argument("--w-scene", type=float, default=1.0)
    ap.add_argument("--w-dino", type=float, default=0.8)
    ap.add_argument("--allow-missing-dino", action="store_true")
    ap.add_argument("--max-steps", type=int, default=None)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[env] device={device} gpu={torch.cuda.get_device_name(0) if device=='cuda' else 'cpu'} "
          f"cuda_avail={torch.cuda.is_available()}", flush=True)

    items = build_items(limit=args.limit, require_dino=not args.allow_missing_dino)
    train_items, val_items = split_items(items)
    print(f"[data] total={len(items)} train={len(train_items)} val={len(val_items)}", flush=True)

    # 教师标量标准化(只用训练集统计,防泄漏)
    tr_tech = np.array([x["tech"] for x in train_items])
    tr_aes = np.array([x["aes"] for x in train_items])
    tech_norm = Normalizer(float(tr_tech.mean()), float(tr_tech.std()))
    aes_norm = Normalizer(float(tr_aes.mean()), float(tr_aes.std()))
    print(f"[norm] tech mean/std={tech_norm.mean:.3f}/{tech_norm.std:.3f} "
          f"aes mean/std={aes_norm.mean:.3f}/{aes_norm.std:.3f}", flush=True)

    train_ds = DistillDataset(train_items, args.input_size, augment=True)
    val_ds = DistillDataset(val_items, args.input_size, augment=False)
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True,
                          num_workers=args.workers, pin_memory=True, drop_last=True)
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False,
                        num_workers=args.workers, pin_memory=True)

    dino_dim = int(items[0]["dino"].shape[0]) if items and items[0]["dino"].shape[0] else 0
    if dino_dim != 768 and not args.allow_missing_dino:
        raise RuntimeError(f"DINOv2 embedding must be 768 dims, got {dino_dim}")
    model = MultiHeadStudent(args.backbone, clip_dim=items[0]["clip"].shape[0], dino_dim=dino_dim,
                             input_size=args.input_size).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.wd)
    total_steps = args.epochs * max(1, len(train_dl))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr,
                                                total_steps=total_steps, pct_start=0.1)
    scaler = torch.amp.GradScaler("cuda", enabled=(device == "cuda"))
    mse = nn.MSELoss()
    mean = IMAGENET_MEAN.to(device)
    std = IMAGENET_STD.to(device)

    best = -1e9
    step = 0
    t0 = time.time()
    for ep in range(args.epochs):
        model.train()
        for px, tech, aes, clip, dino in train_dl:
            px = ((px.to(device, non_blocking=True) - mean) / std)
            tech_t = tech_norm.encode(tech).to(device)
            aes_t = aes_norm.encode(aes).to(device)
            clip_t = clip.to(device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=(device == "cuda")):
                outputs = model(px)
                et, ea, ec = outputs[:3]
                l_tech = mse(et, tech_t)
                l_aes = mse(ea, aes_t)
                l_scene = cosine_loss(ec, clip_t) + 0.1 * mse(ec, clip_t)
                l_dino = torch.tensor(0.0, device=device)
                if len(outputs) > 3 and dino.shape[-1] > 0:
                    dino_t = dino.to(device, non_blocking=True)
                    l_dino = cosine_loss(outputs[3], dino_t) + 0.1 * mse(outputs[3], dino_t)
                loss = args.w_tech * l_tech + args.w_aes * l_aes + args.w_scene * l_scene + args.w_dino * l_dino
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            step += 1
            if step % 20 == 0:
                print(f"[train] ep{ep} step{step} loss={loss.item():.4f} "
                      f"tech={l_tech.item():.4f} aes={l_aes.item():.4f} "
                      f"scene={l_scene.item():.4f} dino={l_dino.item():.4f} lr={sched.get_last_lr()[0]:.2e} "
                      f"t={time.time()-t0:.0f}s", flush=True)
            if args.max_steps and step >= args.max_steps:
                break
        m = evaluate(model, val_dl, device, tech_norm, aes_norm)
        score = m["tech_srcc"] + m["aes_srcc"] + m["clip_cos_mean"] + m["dino_cos_mean"]
        print(f"[eval] ep{ep} {m} score={score:.4f}", flush=True)
        if score > best:
            best = score
            torch.save({
                "model": model.state_dict(),
                "backbone": args.backbone,
                "feat_dim": model.feat_dim,
                "clip_dim": items[0]["clip"].shape[0],
                "dino_dim": dino_dim,
                "input_size": args.input_size,
                "tech_norm": asdict(tech_norm),
                "aes_norm": asdict(aes_norm),
                "metrics": m,
                "epoch": ep,
            }, os.path.join(args.out, "student-best.pt"))
            print(f"[save] best score={best:.4f} ep{ep}", flush=True)
        if args.max_steps and step >= args.max_steps:
            break

    summary = {
        "backbone": args.backbone,
        "epochs": args.epochs,
        "batch": args.batch,
        "lr": args.lr,
        "total_items": len(items),
        "dino_dim": dino_dim,
        "best_score": best,
        "final_metrics": m,
        "tech_norm": asdict(tech_norm),
        "aes_norm": asdict(aes_norm),
        "elapsed_s": time.time() - t0,
    }
    with open(os.path.join(args.out, "train-summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("==TRAIN_DONE==", json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
