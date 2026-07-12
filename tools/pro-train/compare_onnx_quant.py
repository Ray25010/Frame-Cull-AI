#!/usr/bin/env python
"""Compare FP32 and INT8 Pro ONNX outputs on real previews."""
import argparse
import glob
import json
import os

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)


def load_image(path, size=384):
    img = Image.open(path).convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    chw = np.transpose(arr, (2, 0, 1))
    return (chw - MEAN) / STD


def run(sess, batch):
    return sess.run(None, {"pixel_values": batch})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fp32", required=True)
    ap.add_argument("--int8", required=True)
    ap.add_argument("--previews", action="append", required=True)
    ap.add_argument("--limit", type=int, default=256)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    paths = []
    for root in args.previews:
        paths.extend(sorted(glob.glob(os.path.join(root, "*.jpg"))))
    paths = paths[:args.limit]
    fp = ort.InferenceSession(args.fp32, providers=["CPUExecutionProvider"])
    iq = ort.InferenceSession(args.int8, providers=["CPUExecutionProvider"])

    diffs = {"aesthetic": [], "scene_logits": [], "persona": []}
    for start in range(0, len(paths), args.batch):
        batch_paths = paths[start:start + args.batch]
        x = np.stack([load_image(p) for p in batch_paths]).astype("float32")
        a = run(fp, x)
        b = run(iq, x)
        for name, av, bv in zip(diffs.keys(), a, b):
            diffs[name].append(np.abs(av - bv).reshape(len(batch_paths), -1).mean(axis=1))
    report = {"count": len(paths), "models": {"fp32": args.fp32, "int8": args.int8}, "diff": {}}
    for name, values in diffs.items():
        v = np.concatenate(values)
        report["diff"][name] = {
            "meanAbs": float(v.mean()),
            "p95Abs": float(np.percentile(v, 95)),
            "maxAbs": float(v.max()),
        }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("==COMPARE_DONE==", json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
