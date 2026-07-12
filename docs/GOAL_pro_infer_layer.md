# GOAL：实现 Pro 原生推理层（Rust 进程内 onnxruntime + Tauri 对接）

## 背景

FrameCull AI 是 Tauri + React 的本地图片筛选应用，分 Flash / Pro 两版（`FRAMECULL_EDITION` + Cargo `pro` feature）。
当前所有 ONNX 推理都在前端 worker（`onnxruntime-web/wasm`）。Pro 版要把新的蒸馏多头模型（美学/场景/个性偏好）放到 **Rust 端原生 onnxruntime**，吃 GPU 算力并支持 batch。

**权威规格在 `docs/PRO_MODEL_ARCHITECTURE.md` §10。本 prompt 是任务入口，遇到细节冲突以 §10 为准。**

## 目标（Definition of Done）

在 `pro` feature 下新增一条 Rust 进程内推理链路，前端在 Pro edition 下通过 Tauri command 调用，跑通「批量图片路径 → 多头分数」，并满足 §10.9 全部验收项。

## 必须遵守的硬约束（违反即打回）

1. **不动 Flash 的 wasm 链路**：`src/workers/aiAnalyzer.worker.ts`、`src/workers/peopleSplit.worker.ts` 一行不改。
2. **本轮不接管现有模型**：YuNet / MediaPipe Landmarker / SFace / 规则引擎继续在 worker 跑。原生层**只接管新的蒸馏多头模型**。
3. **依赖隔离**：`ort` / `ndarray` 只在 `pro` feature 下引入；Flash 构建（`cargo tree`）**不得含这两个 crate**。
4. **代码隔离**：所有新增 Rust 代码 gate 在 `#[cfg(feature = "pro")]`；前端调用 gate 在 `IS_PRO_EDITION` 后，Flash 运行时不 invoke 任何 `pro_infer_*`。
5. **进程内绑定，非 sidecar**：用 `ort` crate 进程内推理，不开子进程。
6. **传路径不传像素**：前端给图片路径，Rust 端自己解码 + resize 到 **384** + 归一化 + 组 batch。
7. **本轮用占位 ONNX 打通链路**（输入 `[N,3,384,384]`、输出多头 dict），真实模型后续替换；占位模型必须做到「仅改 manifest + 模型文件即可替换，不改代码」。

## 交付物

### Rust（`src-tauri/`）
- 新模块 `src/pro_infer/`（`mod.rs` / `ep.rs` / `session.rs` / `preprocess.rs` / `infer.rs` / `types.rs`），整模块 gate 在 `pro` feature。
- `Cargo.toml`：`pro` feature 追加 `ort` + `ndarray`（optional），各 EP 按平台条件启用（Windows: cuda+directml，macOS: coreml，全平台 CPU 兜底）。版本号与 EP feature 名自行选定并在 PR 说明。
- 两个 command（命名固定）：
  - `pro_infer_init(manifest_path) -> ProInferCapabilities`：探测 EP、加载 backbone + 各头、warmup。
  - `pro_infer_batch(req: ProBatchRequest) -> ProBatchResponse`：批量推理。
- EP 降级链（§10.6）：按平台逐级 try，失败记录原因进 `epFallbackChain`，CPU 兜底永不失败；初始化/warmup 失败**不得 panic 主进程**。
- session 由 `tauri::State` 持有；EP 初始化与 warmup 包在 `Result` 里。
- 在 `lib.rs` 的 invoke_handler 注册新 command（gate 在 pro feature）。

### 前端（`src/`）
- `src/types.ts` 新增 `ProInferCapabilities` / `ProBatchRequest` / `ProHeadScores` / `ProBatchResponse`，字段与 Rust `types.rs` 的 serde 结构**一一对应**（字段名见 §10.5）。
- Pro edition 下，把美学分来源从 worker 的 wasm NIMA 切到原生层，喂给 `photoScoring.ts` 的 `calibratedAestheticModelScore` 接入点。`scene/persona` 字段本轮返回占位即可，但类型一次定全。

### 接口契约（与 §10.5 完全一致，不要改字段名）
```ts
ProInferCapabilities { activeEp; epFallbackChain; backboneVersion; loadedHeads; inputResolution(===384); warmupMs }
ProBatchRequest      { imagePaths; batchSize?; heads? }
ProHeadScores        { imagePath; aesthetic?; sceneLabel?; sceneConfidence?; personaScore?; error? }
ProBatchResponse     { results; ep; elapsedMs }
```

## 验收（codex 自测，对齐 §10.9）

1. `pnpm tauri:build:flash` 成功；`cargo tree`（flash）不含 ort/ndarray。
2. `pnpm tauri:build:pro` 成功，含 `pro_infer` 模块与 command 注册。
3. Windows N 卡：`pro_infer_init` 返回 `activeEp:'cuda'`、`inputResolution:384`；CUDA 失败回落 directml 并记录原因。
4. Apple Silicon：`activeEp:'coreml'`，CoreML 算子回退有日志。
5. `pro_infer_batch` 对一批图返回每图 `aesthetic`；单图损坏只在该图 `error`，不挂全批。
6. batch 吞吐 > 单图循环（同机对照）。
7. Flash 运行时无 `pro_infer_*` invoke；Pro 运行时美学分来自原生层。
8. 占位模型可仅改 manifest + 模型文件替换，不改代码。
9. EP/session 初始化失败不 panic，按降级链回落，最坏 CPU 可用。

> 硬隔离项（1/2/7/8）必须全过。跨平台/健壮性（3/4/9）按真机判。功能/性能（5/6）为基线。

## 工作方式要求

- 单个 PR 完成，commit 粒度清晰；PR 说明里写明：选定的 `ort` 版本与各 EP feature 名、占位模型规格、未覆盖的真机平台（如手头无某硬件）。
- 不引入 §10 之外的架构改动；如发现规格有歧义或与现有代码冲突，**先在 PR 说明里提出**，不要擅自扩大范围。
- 完成后产出可供审查的 diff，并附上验收项 1/2/5/6 的本地运行结果（3/4 若无真机请注明）。
