#!/usr/bin/env python3
"""Generate the placeholder Pro inference ONNX model and manifest.

The placeholder exists only to prove the native `ort` inference link end to end.
It defines the exact tensor contract the real distilled multi-head model will
honor, so swapping in the trained model means replacing `model.onnx` + editing
`manifest.json` only -- no Rust/TS code changes.

Contract:
  input  : pixel_values  float32 [N, 3, 384, 384]  (N is dynamic)
  outputs:
    aesthetic       float32 [N, 1]   -> 0..1 after sigmoid
    scene_logits    float32 [N, K]   -> argmax/softmax in Rust for sceneLabel
    persona         float32 [N, 1]   -> 0..1 after sigmoid

The graph is intentionally tiny (global pool -> gemm per head) so every EP can
run it without unsupported operators.
"""
import argparse
import json
import hashlib
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

INPUT_RES = 384
CHANNELS = 3
SCENE_CLASSES = 4
SCENE_LABELS = ["outdoor_portrait", "indoor_portrait", "scenery", "other"]


def build_model() -> onnx.ModelProto:
    rng = np.random.default_rng(20260620)

    pixel_values = helper.make_tensor_value_info(
        "pixel_values", TensorProto.FLOAT, ["N", CHANNELS, INPUT_RES, INPUT_RES]
    )
    aesthetic = helper.make_tensor_value_info("aesthetic", TensorProto.FLOAT, ["N", 1])
    scene_logits = helper.make_tensor_value_info(
        "scene_logits", TensorProto.FLOAT, ["N", SCENE_CLASSES]
    )
    persona = helper.make_tensor_value_info("persona", TensorProto.FLOAT, ["N", 1])

    pooled = helper.make_node(
        "GlobalAveragePool", ["pixel_values"], ["pooled"], name="global_pool"
    )
    flatten = helper.make_node(
        "Flatten", ["pooled"], ["features"], name="flatten", axis=1
    )

    def head(name, out_name, out_dim, sigmoid):
        w = numpy_helper.from_array(
            (rng.standard_normal((CHANNELS, out_dim)).astype(np.float32) * 0.1),
            name=f"{name}_w",
        )
        b = numpy_helper.from_array(
            np.zeros((out_dim,), dtype=np.float32), name=f"{name}_b"
        )
        gemm_out = out_name if not sigmoid else f"{name}_logit"
        nodes = [
            helper.make_node(
                "Gemm", ["features", f"{name}_w", f"{name}_b"], [gemm_out], name=f"{name}_gemm"
            )
        ]
        if sigmoid:
            nodes.append(
                helper.make_node("Sigmoid", [gemm_out], [out_name], name=f"{name}_sigmoid")
            )
        return nodes, [w, b]

    aesthetic_nodes, aesthetic_init = head("aesthetic", "aesthetic", 1, sigmoid=True)
    scene_nodes, scene_init = head("scene", "scene_logits", SCENE_CLASSES, sigmoid=False)
    persona_nodes, persona_init = head("persona", "persona", 1, sigmoid=True)

    graph = helper.make_graph(
        [pooled, flatten, *aesthetic_nodes, *scene_nodes, *persona_nodes],
        "framecull_pro_placeholder",
        [pixel_values],
        [aesthetic, scene_logits, persona],
        [*aesthetic_init, *scene_init, *persona_init],
    )
    model = helper.make_model(
        graph,
        producer_name="framecull-pro-placeholder",
        opset_imports=[helper.make_operatorsetid("", 13)],
    )
    model.ir_version = 9
    onnx.checker.check_model(model)
    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parents[2] / "src-tauri" / "pro-models" / "placeholder"),
    )
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    model = build_model()
    model_path = out_dir / "model.onnx"
    onnx.save(model, str(model_path))

    digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "backboneVersion": "placeholder-v0",
        "model": "model.onnx",
        "sha256": digest,
        "inputName": "pixel_values",
        "inputResolution": INPUT_RES,
        "channels": CHANNELS,
        "normalize": {
            "mean": [0.485, 0.456, 0.406],
            "std": [0.229, 0.224, 0.225],
        },
        "heads": [
            {"name": "aesthetic", "output": "aesthetic", "kind": "scalar01"},
            {
                "name": "scene",
                "output": "scene_logits",
                "kind": "classifier",
                "labels": SCENE_LABELS,
            },
            {"name": "persona", "output": "persona", "kind": "scalar01"},
        ],
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {model_path} ({model_path.stat().st_size} bytes)")
    print(f"sha256 {digest}")
    print(f"wrote {out_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
