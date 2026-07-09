# Arbor Contract: FrameCull Pro Research Lab

## Target

- Target project: `C:\Users\29238\Documents\筛图app`
- Research workspace: `research/arbor-framecull-lab`
- Current branch at setup: `codex/apple-ui-redesign`
- Mode: skill-only Arbor reconstruction, smoke/setup mode.

## Task

把 FrameCull 的 AI / Pro 模型研发工作整理成 Arbor 风格的持久研究空间：目标、数据、指标、实验、证据和报告分层管理，同时不改动软件开发主体。

## Metric

Primary research metrics:

- low-ratio AI Pick recall at `38% / 45% / 50% / 60%`;
- false-face risk by scene, especially student-layer full-dataset `grounded - flat`;
- negative pick rate;
- duplicate pollution;
- model latency and package size.

Direction:

- maximize recall under hard gates;
- minimize false-face risk, negative picks, duplicate pollution, latency, and package size.

## Baseline Anchor

Known current evidence:

- v11 semantic best recall at 45%: `56.85%`.
- current production recall at 45% in the same summary: `42.19%`.
- v11 recall trade-off: `+14.66% @45%`.
- false-face v11 student-layer original delta: `+0.2883`, target `< +0.05`, status `FAIL`.
- old false-face v1 delta: `+0.3032`.

These are evidence anchors, not final product claims.

## Evaluation Policy

- B_dev: cached lab outputs and paper snapshots under `output/`.
- B_test: any future held-out shoot / new user dataset. Do not use B_test for routine iteration.
- Expensive eval, GPU jobs, downloads, package installs, or retraining require explicit user approval.
- Cached evidence may be used for planning, reporting, and smoke Arbor plumbing.

## Protected Paths

Do not modify as part of R&D workspace restructuring:

- `src/`
- `src-tauri/src/`
- `src-tauri/tauri*.conf.json`
- `package.json`
- `pnpm-lock.yaml`
- product README files unless the user asks for product docs
- raw datasets on external drives
- remote server data except through explicit sync/archive tasks

Allowed edit surface for this setup:

- `research/arbor-framecull-lab/**`

## Scope Preference

Mixed:

- effect-leaning for measurable recall / false-face / latency improvements;
- novelty-leaning for teacher-student research ideas that may support a paper.

## Budget

This setup run is smoke/setup only:

- no training;
- no model inference;
- no package install;
- no source refactor;
- no branch merge.

Future real runs should set explicit cycle/time/GPU budgets.

## Human Gate

Interaction mode: review.

The agent may create research plans, indexes, and Arbor session artifacts. Product code changes, long jobs, and merge attempts require user review.
