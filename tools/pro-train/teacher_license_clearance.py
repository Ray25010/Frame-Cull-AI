#!/usr/bin/env python
"""Generate the Semantic Teacher license clearance gate report.

This is a conservative gate: only models with a known permissive license are
marked as usable for labels that may be distilled into redistributed Pro
student weights. Unknown or research-only teachers can still be listed as
ablation/reference teachers, but the script marks them as not cleared for full
annotation.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.request import urlopen


KNOWN_TEACHERS = {
    "qwen2.5-vl-7b": {
        "display": "Qwen2.5-VL-7B-Instruct",
        "license": "Apache-2.0",
        "source": "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct",
        "snapshot": "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/raw/main/README.md",
        "commercialDistillation": "cleared",
        "notes": "Primary production teacher candidate. Keep an exact model-card snapshot alongside this report before full annotation.",
    },
    "qwen2.5-vl-7b-instruct": {
        "display": "Qwen2.5-VL-7B-Instruct",
        "license": "Apache-2.0",
        "source": "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct",
        "snapshot": "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/raw/main/README.md",
        "commercialDistillation": "cleared",
        "notes": "Primary production teacher candidate. Keep an exact model-card snapshot alongside this report before full annotation.",
    },
    "internvl3-8b": {
        "display": "InternVL3-8B",
        "license": "Apache-2.0",
        "source": "https://huggingface.co/OpenGVLab/InternVL3-8B",
        "snapshot": "https://huggingface.co/OpenGVLab/InternVL3-8B/raw/main/README.md",
        "commercialDistillation": "cleared",
        "notes": "Current Hugging Face model card shows Apache-2.0. Archive the exact README snapshot before using this teacher for official full annotation.",
    },
    "internvl3-14b": {
        "display": "InternVL3-14B",
        "license": "Apache-2.0",
        "source": "https://huggingface.co/OpenGVLab/InternVL3-14B",
        "snapshot": "https://huggingface.co/OpenGVLab/InternVL3-14B/raw/main/README.md",
        "commercialDistillation": "cleared",
        "notes": "Current Hugging Face model card shows Apache-2.0. License is acceptable; 32GB fit remains a separate runtime check, not a license block.",
    },
}


def model_record(model: str) -> dict:
    key = model.lower()
    item = dict(KNOWN_TEACHERS.get(key, {}))
    if not item:
        item = {
            "display": model,
            "license": "unknown",
            "source": "unknown",
            "snapshot": "unknown",
            "commercialDistillation": "blocked",
            "notes": "Unknown license. Not cleared for full teacher annotation.",
        }
    item["id"] = model
    item["clearedForFullAnnotation"] = item["commercialDistillation"] == "cleared"
    return item


def write_markdown(path: Path, payload: dict) -> None:
    lines = [
        "# FrameCull Semantic Teacher License Clearance",
        "",
        f"- Created at: `{payload['createdAt']}`",
        f"- Gate status: **{payload['gateStatus']}**",
        "",
        "This gate exists because teacher outputs are distilled into Pro student weights that may be redistributed. A teacher may be safe for research comparison but not safe for commercial student training.",
        "",
        "| Teacher | License | Source | Snapshot | Distillation status | Cleared for full annotation | Notes |",
        "|---|---|---|---|---|---|---|",
    ]
    for item in payload["teachers"]:
        cleared = "yes" if item["clearedForFullAnnotation"] else "no"
        lines.append(
            f"| `{item['display']}` | `{item['license']}` | {item['source']} | "
            f"{item.get('snapshot', 'unknown')} | `{item['commercialDistillation']}` | {cleared} | {item['notes']} |"
        )
    lines += [
        "",
        "## Rules",
        "",
        "- Only `cleared` teachers may produce the official full semantic teacher labels.",
        "- `manual-review` or `blocked` teachers may be used only for research/ablation outputs kept out of shipped student weights.",
        "- Archive the exact upstream model-card/license snapshot next to this report before launching full annotation.",
        "- Source URL and snapshot URL must point to the exact checkpoint page, not just the org root.",
    ]
    snapshot_rows = payload.get("snapshotFetch") or []
    if snapshot_rows:
        lines += [
            "",
            "## Snapshot Fetch",
            "",
            "| Teacher id | Status | Local path | Error |",
            "|---|---|---|---|",
        ]
        for row in snapshot_rows:
            lines.append(
                f"| `{row.get('id')}` | `{row.get('status')}` | `{row.get('path', '')}` | `{row.get('error', '')}` |"
            )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def fetch_snapshots(out_dir: Path, teachers: list[dict]) -> list[dict]:
    snapshot_dir = out_dir / "teacher-license-snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for item in teachers:
        url = str(item.get("snapshot") or "").strip()
        if not url or url == "unknown":
            results.append({"id": item["id"], "status": "missing-url"})
            continue
        target = snapshot_dir / f"{item['id']}.README.md"
        try:
            with urlopen(url, timeout=30) as response:
                body = response.read().decode("utf-8", "replace")
            target.write_text(body, encoding="utf-8")
            results.append({"id": item["id"], "status": "fetched", "path": str(target)})
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            results.append({"id": item["id"], "status": "fetch-failed", "error": str(error), "path": str(target)})
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teachers", required=True, help="Comma-separated teacher ids, e.g. qwen2.5-vl-7b,internvl3-8b")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fetch-snapshots", action="store_true", help="Download the referenced model-card README snapshots next to the report.")
    args = parser.parse_args()
    teachers = [model_record(item.strip()) for item in args.teachers.split(",") if item.strip()]
    cleared = [item for item in teachers if item["clearedForFullAnnotation"]]
    payload = {
        "schemaVersion": "framecull-teacher-license-clearance-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "teachers": teachers,
        "gateStatus": "PASS" if cleared else "BLOCKED",
        "clearedTeacherIds": [item["id"] for item in cleared],
    }
    args.out.mkdir(parents=True, exist_ok=True)
    if args.fetch_snapshots:
        payload["snapshotFetch"] = fetch_snapshots(args.out, teachers)
    (args.out / "teacher-license-clearance.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(args.out / "teacher-license-clearance.md", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if cleared else 2


if __name__ == "__main__":
    raise SystemExit(main())
