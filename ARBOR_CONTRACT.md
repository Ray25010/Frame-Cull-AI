# Arbor Contract: Pro Native RAW Preview P1

## Target
- Project: `C:\Users\29238\Documents\筛图app`
- Branch at launch: `codex/apple-ui-redesign`
- Session: `.arbor/sessions/pro-native-raw-preview-p1`

## Task
先保留当前 Pro / Flash 现有链路，启动一个隔离的 Pro Native RAW Preview Lab 管线 1。

管线 1 只验证：
- 使用 Rust native RAW 解码库读取真实 RAW，优先验证 Nikon NEF。
- 输出 2K 级预览 JPEG 与基础耗时指标。
- 记录失败原因；失败时保持“回退内嵌预览”的产品策略。

本轮不做：
- 不接入 Flash。
- 不替换现有 RawTherapee 监看缓存。
- 不把实验依赖打进正式安装包。
- 不做长时间全量训练或大规模 GPU 作业。

## Metric
- `decodeSuccessRate`: maximize
- `medianDecodeMs`: minimize
- `badPreviewRate`: minimize
- `appIsolation`: Flash build must remain free of new native RAW / GPU lab dependencies

## Evaluation
- Smoke command: run the lab tool on `G:\DCIM\110NZ6_3\_DSC0552.NEF` when present.
- Folder smoke command: run the lab tool on `G:\DCIM\110NZ6_3` with `--limit 10`.
- Build guard: `pnpm run build:pro`, `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features`

## Baseline
- Current RawTherapee CLI monitor cache can emit a readable but visually corrupted JPEG for `_DSC0552.NEF`.
- Current safe fallback is embedded preview when monitor cache is missing or rejected.

## Budget And Mode
- Mode: smoke-first
- Interaction: review
- Stop condition: isolated P1 tool and report exist, with at least one Nikon NEF smoke result or a clear blocker.
