# FrameCull AI Lab

Offline evaluation helpers for FrameCull AI model experiments. This folder is not part of the Tauri app bundle.

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r tools/ai-lab/requirements.txt
```

## Face Detection Evaluation

`evaluate_faces.py` compares model predictions against hand annotations and writes visual diagnostics.

```powershell
python tools/ai-lab/evaluate_faces.py `
  --images C:\path\to\photos `
  --predictions C:\path\to\predictions.json `
  --annotations C:\path\to\annotations.json `
  --out C:\path\to\ai-lab-output
```

JSON format:

```json
{
  "DSC0001.JPG": [
    { "xyxy": [120, 80, 220, 210], "confidence": 0.91, "label": "face" }
  ]
}
```

The output includes `summary.json` and marked images. Green boxes are matched detections, red boxes are false positives, and amber boxes are missed annotations.

## Local Performance Benchmarks

`bench-ai-culling.html` and `run-ai-bench-cdp.mjs` measure the real browser workers used by FrameCull AI. They run through Vite and Microsoft Edge DevTools, so the benchmark uses the same YuNet, MediaPipe, SFace, ONNX Runtime, image scaling, and worker code as the app.

Start Vite first:

```powershell
pnpm run dev -- --host 127.0.0.1 --port 3000
```

For WebGPU backend experiments, start Vite with the experimental flag:

```powershell
$env:VITE_FRAMECULL_ENABLE_WEBGPU='1'
pnpm run dev -- --host 127.0.0.1 --port 3000
```

AI culling throughput:

```powershell
$env:FRAMECULL_BENCH_LIMIT='60'
$env:FRAMECULL_BENCH_MAX_EDGE='1800'
$env:FRAMECULL_BENCH_CONCURRENCIES='3,4,5,6'
node tools/ai-lab/run-ai-bench-cdp.mjs "C:\path\to\photos"
```

People Split throughput:

```powershell
$env:FRAMECULL_BENCH_MODE='people'
$env:FRAMECULL_BENCH_LIMIT='60'
$env:FRAMECULL_BENCH_CONCURRENCIES='1,2,3,4,5,6'
node tools/ai-lab/run-ai-bench-cdp.mjs "C:\path\to\photos"
```

AI culling and People Split together:

```powershell
$env:FRAMECULL_BENCH_MODE='combined'
$env:FRAMECULL_BENCH_LIMIT='36'
$env:FRAMECULL_BENCH_MAX_EDGE='1800'
$env:FRAMECULL_BENCH_COMBOS='6x1,6x2,5x1,5x2,4x2'
node tools/ai-lab/run-ai-bench-cdp.mjs "C:\path\to\photos"
```

WebGPU probe and backend comparison:

```powershell
$env:FRAMECULL_BENCH_MODE='probe'
node tools/ai-lab/run-ai-bench-cdp.mjs "C:\path\to\photos"

$env:FRAMECULL_BENCH_MODE='ai'
$env:FRAMECULL_BENCH_BACKEND='webgpu'
$env:FRAMECULL_BENCH_LIMIT='60'
$env:FRAMECULL_BENCH_MAX_EDGE='1800'
$env:FRAMECULL_BENCH_CONCURRENCIES='1,2,3,4'
node tools/ai-lab/run-ai-bench-cdp.mjs "C:\path\to\photos"

$env:FRAMECULL_BENCH_MODE='people'
$env:FRAMECULL_BENCH_BACKEND='webgpu'
$env:FRAMECULL_BENCH_LIMIT='60'
$env:FRAMECULL_BENCH_CONCURRENCIES='1,2,3,4'
node tools/ai-lab/run-ai-bench-cdp.mjs "C:\path\to\photos"
```

Results are written to `output/ai-bench/`, which is intentionally ignored by git.

## Aesthetic Candidate Model Lab

`bench-aesthetic-candidates.py` compares the current FrameCull/NIMA audit baseline with lab-only MUSIQ and CLIP-IQA / CLIP-aesthetic candidates. Candidate model files and caches stay outside the app bundle under `D:\FrameCullModelLab`.

Create the heavy model environment on `D:` so Torch, PyIQA, and downloaded weights do not fill the system drive:

```powershell
$basePy='C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$lab='D:\FrameCullModelLab'
& $basePy -m venv "$lab\.venv"
$py="$lab\.venv\Scripts\python.exe"
```

Keep all Python and model caches on `D:` before installing or running candidates:

```powershell
$env:FRAMECULL_MODEL_LAB_DIR=$lab
$env:HF_HOME="$lab\cache\huggingface"
$env:HUGGINGFACE_HUB_CACHE="$lab\cache\huggingface\hub"
$env:TRANSFORMERS_CACHE="$lab\cache\huggingface\transformers"
$env:TORCH_HOME="$lab\cache\torch"
$env:XDG_CACHE_HOME="$lab\cache\xdg"
$env:PIP_CACHE_DIR="$lab\cache\pip"
& $py -m pip install -r tools/ai-lab/requirements-aesthetic-candidates.txt
```

For NVIDIA GPUs, replace the CPU Torch wheel with the CUDA wheel in the same `D:` venv:

```powershell
$env:TEMP="$lab\cache\tmp"
$env:TMP="$lab\cache\tmp"
& $py -m pip install --force-reinstall --no-deps `
  --index-url https://download.pytorch.org/whl/cu129 `
  torch==2.8.0+cu129 torchvision==0.23.0+cu129
```

Baseline-only smoke test:

```powershell
& $py tools/ai-lab/bench-aesthetic-candidates.py `
  --stage smoke-60 `
  --models nima-baseline
```

Balanced supervised sample before a full run:

```powershell
powershell -ExecutionPolicy Bypass -File tools/ai-lab/run-aesthetic-candidates.ps1 `
  -Stage balanced-labels `
  -Models nima-baseline,musiq-ava-pyiqa,clipiqa-pyiqa `
  -Device cuda `
  -CandidateMaxEdge 1024
```

Full candidate run against the RAW+XMP audit set:

```powershell
powershell -ExecutionPolicy Bypass -File tools/ai-lab/run-aesthetic-candidates.ps1 `
  -Stage radius-3-context `
  -Models nima-baseline,musiq-ava-pyiqa,clipiqa-pyiqa `
  -Device cuda `
  -CandidateMaxEdge 1024
```

CPU-only CLIP-IQA and MUSIQ are much slower. On the RTX 5060 Laptop GPU, `musiq-ava-pyiqa` works after resizing candidate inputs to a 1024px long edge; running it on full embedded previews can exceed 8 GB VRAM.

The script writes:

- `model-comparison` JSON with metrics, manifests, recommendation, and failure samples
- CSV with per-photo labels, baseline scores, candidate scores, and latencies
- Markdown summary with the decision table

Evaluation rules:

- XMP `rating >= 3` is positive; `0/1` is negative; unlabeled photos are context only.
- Ratings are never used as ranking input.
- Hard focus/blur/AI issue gates stay ahead of aesthetic scores.
- A candidate should only move toward production if it improves positive recall by at least 5 percentage points or duplicate-group coverage by at least 8 points without increasing duplicate pollution.

## Supervised AI Pick Tuning

`tune-ai-picks-supervised.mjs` searches AI Pick rules against the RAW+XMP audit labels without rerunning RAW decode or large aesthetic models. It joins:

- the latest or specified `ai-culling-bench-*.json`
- `D:\FrameCullRawAudit\raw-audit-previews\labels.json`
- the aesthetic candidate CSV from `bench-aesthetic-candidates.py`

Run the reproducible wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File tools/ai-lab/run-supervised-ai-picks.ps1 `
  -Audit output\ai-bench\ai-culling-bench-1781541318533.json `
  -Candidates output\ai-bench\aesthetic-candidates\aesthetic-candidates-20260616-104143.csv `
  -Labels D:\FrameCullRawAudit\raw-audit-previews\labels.json `
  -Lab D:\FrameCullModelLab
```

If the existing RAW audit was generated before duplicate signatures were exported, enrich it from the JPG previews without rerunning the full AI worker pipeline:

```powershell
& D:\FrameCullModelLab\.venv\Scripts\python.exe tools\ai-lab\enrich-ai-audit-duplicates.py `
  --audit output\ai-bench\ai-culling-bench-1781541318533.json `
  --previews D:\FrameCullRawAudit\raw-audit-previews `
  --output output\ai-bench\ai-culling-bench-1781541318533-duplicate-enriched.json `
  --workers 10

powershell -ExecutionPolicy Bypass -File tools/ai-lab/run-supervised-ai-picks.ps1 `
  -Audit output\ai-bench\ai-culling-bench-1781541318533-duplicate-enriched.json `
  -Candidates output\ai-bench\aesthetic-candidates\aesthetic-candidates-20260616-104143.csv `
  -Labels D:\FrameCullRawAudit\raw-audit-previews\labels.json `
  -Lab D:\FrameCullModelLab `
  -Output output\ai-bench\supervised-ai-picks-enriched
```

The runner keeps Torch/HuggingFace/PyIQA cache variables pointed at `D:\FrameCullModelLab`, probes CUDA through the D-drive venv, and writes:

- `output\ai-bench\supervised-ai-picks\summary.md`
- `metrics.csv`
- `selected-config.json`
- `false-negatives.csv`
- `duplicate-pollution.csv`
- `supervised-ai-picks-result.json`

Evaluation rules:

- XMP `rating >= 3` is positive; `0/1` is negative.
- Ratings are only evaluation labels and are asserted out of ranking features.
- Hard issues, focus fail, obvious blur, and rejected photos cannot become duplicate representatives.
- New `pick-audit` exports include per-photo `duplicateSignature`, `pairSimilarities`, `compactDuplicateGroups`, `burstGroups`, and `pickDecisionReasons`.
- If the audit JSON has `pairSimilarities`, the runner searches perceptual-similarity thresholds and compact visual components. Older audit JSON falls back to formal duplicate representatives, ranking weights, and AI Pick fill ratios.
- The visual grouping search follows the same broad ideas as fastdup connected similarity components and imagededup perceptual-hash threshold search, while keeping MUSIQ / CLIP-IQA as lab-only assisted ranking features.

Current 2026-06-16 supervised result on the 3-folder audit set:

| Strategy | Picked | Rating >=3 recall | Formal duplicate multi-pick | Notes |
| --- | ---: | ---: | ---: | --- |
| Current production snapshot | 1535 | 47.9% | 70 | Baseline from existing audit JSON |
| Lightweight fused-technical, formal duplicates, 60% | 1955 | 59.1% | 0 | Best default-production candidate |
| CLIP-assisted, formal duplicates, 60% | 1955 | 60.8% | 0 | Higher recall, but heavier and more negative picks |
| MUSIQ-assisted, formal duplicates, 60% | 1955 | 59.2% | 0 | Similar to lightweight, not worth default bundle cost |

Recommendation from this run: keep MUSIQ and CLIP-IQA as lab/optional candidates, and first productionize the lightweight formal-duplicate representative plus fused technical ranking strategy. This audit was generated before `pairSimilarities` existed, so the next full RAW+XMP run should regenerate `pick-audit` first and then use the v2 runner to compare true visual-similarity thresholds.

Quick smoke test for the new schema:

```powershell
$env:FRAMECULL_BENCH_MODE='pick-audit'
$env:FRAMECULL_BENCH_LIMIT='24'
$env:FRAMECULL_BENCH_MAX_EDGE='1400'
$env:FRAMECULL_BENCH_AUDIT_CONCURRENCY='3'
$env:FRAMECULL_AI_PICK_TARGET_RATIO='0.6'
node tools/ai-lab/run-ai-bench-cdp.mjs 'D:\testjpg'
```

On 2026-06-16 this wrote `pairSimilarities: 276`, `compactDuplicateGroups: 1`, and `pickDecisionReasons: 23` for the 24-file smoke run. The compact duplicate output excludes singleton buckets so duplicate-pollution metrics only count real visual groups.

2026-06-16 enriched RAW+XMP result:

| Strategy | Picked | Rating >=3 recall | Positive group coverage | 0/1-star pick | Visual duplicate multi-pick | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Current production snapshot | 1535 | 47.9% | 95.8% | 51.8% | 70 formal dup multi-picks | Baseline from old audit |
| Formal duplicates, fused technical, 60% | 1955 | 59.1% | 96.9% | 61.1% | 0 | Good fallback when pair similarities are missing |
| Pair similarity 0.84, fused technical, 60% | 1955 | 62.9% | 97.6% | 59.3% | 0 | Best lightweight production candidate |
| Audit compact + CLIP assisted, 60% | 1955 | 62.9% | 97.6% | 55.6% | 0 | Similar recall but depends on heavy optional model output |

Selected production constants from the enriched run:

- `aiPickTargetRatio`: `0.6`
- `groupMode`: `pair-threshold`
- `similarityThreshold`: `0.84`
- `maxNumericGap`: `18`
- `maxTimeGapMs`: `1800000`
- `maxBurstSize`: `5`
- `rankMode`: `fused-technical`
- `gateMode`: `hard-only`
- `enableMusiqDefault`: `false`
- `enableClipIqaDefault`: `false`

## Personal Aesthetic Ranker Lab

`train-personal-ranker.py` trains small personal AI Pick ranking heads from the
RAW+XMP audit set. It does not replace hard issue detection or duplicate
representative gates. XMP ratings are supervision and evaluation labels only;
`rating`, folder name, source path, and file name are excluded from ranking
features.

### Recover Lightroom Classic Ratings

If a labeled shoot was rated on another Lightroom Classic machine and the RAW
files do not contain the expected XMP ratings, use
`tools/lightroom-rating-exporter` on the machine that has the Lightroom catalog.
The helper opens a tiny GUI, searches common `.lrcat` locations, and writes a
return package with `labels-from-lrcat.json` and `ratings.csv`. It only reads the
catalog; it does not modify photos or Lightroom.

Run the full reproducible lab:

```powershell
powershell -ExecutionPolicy Bypass -File tools/ai-lab/run-personal-ranker.ps1 `
  -Audit output\ai-bench\ai-culling-bench-scene-aware-replay.json `
  -Labels D:\FrameCullRawAudit\raw-audit-previews\labels.json `
  -Previews D:\FrameCullRawAudit\raw-audit-previews `
  -Lab D:\FrameCullModelLab `
  -Output output\ai-bench\personal-ranker
```

The wrapper keeps HuggingFace, Torch, CLIP, temporary files, and embedding
caches under `D:\FrameCullModelLab`. Frozen feature caches are written to
`D:\FrameCullModelLab\features\personal-ranker`.

Compared heads:

- `core-linear`: existing FrameCull technical / scene / NIMA / duplicate features with a tiny linear head.
- `core-mlp`: existing FrameCull features with a small MLP head.
- `clip-linear`: OpenAI CLIP ViT-B/32 frozen image embeddings plus a linear head.
- `fused-clip-linear`: existing features plus CLIP embeddings.
- `dinov2-linear`: DINOv2 ViT-S/14 frozen image embeddings plus a linear head.
- `fused-dinov2-linear`: existing features plus DINOv2 embeddings.

Outputs:

- `summary.md`
- `metrics-by-ratio.csv`
- `selected-ranker.json`
- `false-negatives.csv`
- `duplicate-pollution.csv`
- `feature-importance.csv`

Current 2026-06-17 result on the 3-folder XMP audit set:

| Ranker | Low-ratio result | Production decision |
| --- | --- | --- |
| Existing FrameCull score | Baseline stayed strongest overall at 38/45/50 in embedding runs | Keep as current baseline |
| Core MLP | Small gain at 38/50/60, but high train AUC vs low OOF AUC shows overfitting | Do not ship yet |
| CLIP frozen embedding | OOF AUC improved, but low-ratio recall dropped and negative picks rose | Lab only |
| DINOv2 frozen embedding | OOF AUC improved, but low-ratio recall dropped and negative picks rose | Lab only |

Recommendation: no production ranker change yet. The current 814 labeled photos
are enough to prove the lab pipeline, but not enough to ship a personal aesthetic
ranker. Keep collecting more XMP-labeled shoots, then rerun this lab. A personal
ranker should only enter production if it improves 38/45/50% recall without
raising duplicate pollution or 0/1-star false positives.

## 2026-06-11 Benchmark Strategy Notes

Dataset: `C:\Users\29238\Desktop\新建文件夹 (4)`, 84 JPG + 72 NEF. Test machine: AMD Ryzen AI 9 H 465, 20 logical threads, Radeon 880M, RTX 5060 Laptop GPU.

Measured results on 60 JPG files:

| Pipeline | Backend | Best workers | Throughput |
| --- | --- | ---: | ---: |
| AI culling, 1800px | WASM SIMD | 5 | ~8.98 img/s |
| AI culling, 1800px | WebGPU | 4 | ~6.15-6.66 img/s |
| People Split, 1440px | WASM SIMD | 5 | ~7.21 img/s |
| People Split, 1440px | WebGPU | 4 | ~4.05 img/s |
| AI + People together | WASM + WASM | 5 + 3 | ~14.0s wall time / 60 images |
| AI + People together | WebGPU + WASM | 3 + 4 | ~13.1s wall time / 60 images |
| AI + People together | WASM + WebGPU | 4-5 + 4 | ~21.6s wall time / 60 images |

Current production default stays on WASM SIMD. WebGPU is available in the lab, but it is not enabled by default because YuNet and SFace are small models and GPU scheduling/data transfer overhead is larger than the compute saved on this machine. The only measured WebGPU win was a narrow combined-run case where AI WebGPU slightly reduced CPU contention, but it is not stable enough to make the default.

## People Split precision audit

Use the read-only production-worker runner to export face diagnostics, identity
embeddings, automatic clusters, and a visual contact sheet:

```powershell
node tools/ai-lab/run-people-split-precision-cdp.mjs `
  --input "C:\path\to\photos" `
  --output "output\people-split-precision\dev-baseline" `
  --label "dev-baseline" `
  --concurrency 1
```

The command never writes to the source folder. Raw JSON, summary metrics, and
the contact sheet are written only to the selected output directory.

Recommended defaults:

| Machine class | AI culling | People Split single run | AI + People together |
| --- | --- | --- | --- |
| No WebGPU / no dedicated GPU | WASM, 2-4 workers by CPU cores | WASM, 2-4 workers | WASM + WASM, keep People at 1-2 workers |
| Integrated or weak GPU | WASM | WASM | WASM + WASM |
| Strong CPU, mixed GPU laptop | WASM, 5 workers on 16+ logical threads | WASM, 5 workers on 16+ logical threads | WASM + WASM, AI 5 + People 3 |
| Strong dedicated GPU | Run the lab first | Run the lab first | Enable WebGPU only if the lab shows at least a 15% wall-time win with zero errors |

Quality check: on a 40 JPG subset, WASM and WebGPU produced zero differences in face counts, candidate counts, primary subject counts, subject confidence, and diagnostic region counts. Quality rule: do not enable a faster backend unless detection counts, primary subject counts, and people cluster inputs stay consistent on the same image set.
