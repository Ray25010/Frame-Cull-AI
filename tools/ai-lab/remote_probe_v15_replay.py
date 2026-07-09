from __future__ import annotations

import importlib.util
import json
from pathlib import Path


BASE = Path("/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-grounded-v14-five-mountain-region")


def main() -> None:
    print("base", BASE)
    for module in ["cv2", "onnxruntime", "numpy", "PIL"]:
        print("module", module, importlib.util.find_spec(module) is not None)
    for name in [
        "ai-culling-bench-pro-semantic.json",
        "ai-culling-bench-pro-semantic-eval-input.json",
        "pro-infer-latency.json",
        "pro-semantic-eval-labels.json",
        "pro-semantic-eval-input-meta.json",
        "metrics-by-ratio.csv",
        "supervised-ai-picks-result.json",
    ]:
        path = BASE / name
        print("file", name, path.exists(), path.stat().st_size if path.exists() else None)
        if path.suffix == ".json" and path.exists():
            with path.open(encoding="utf-8") as f:
                data = json.load(f)
            rows = data.get("photoSummaries") or data.get("results") or []
            print(" rows", len(rows), "keys", list(rows[0].keys())[:16] if rows else list(data.keys())[:16])
            if name == "pro-semantic-eval-input-meta.json":
                print(" stats", json.dumps(data.get("stats"), ensure_ascii=False, sort_keys=True))
    for root in [
        Path("/data/FrameCullModelLab/incoming/raw-audit-previews"),
        Path("/data/FrameCullModelLab/incoming/camera-previews-384"),
        Path("/data/FrameCullModelLab/incoming/five-mountain-previews-384"),
    ]:
        print("preview_dir", root, root.exists(), len(list(root.glob("*"))) if root.exists() else 0)
    for path in [
        Path("/data/FrameCullModelLab/workspace/public/models/opencv/yunet/face_detection_yunet_2023mar.onnx"),
        Path("/data/FrameCullModelLab/FrameCull/public/models/opencv/yunet/face_detection_yunet_2023mar.onnx"),
        Path("/data/FrameCullModelLab/public/models/opencv/yunet/face_detection_yunet_2023mar.onnx"),
    ]:
        print("yunet", path, path.exists(), path.stat().st_size if path.exists() else None)


if __name__ == "__main__":
    main()
