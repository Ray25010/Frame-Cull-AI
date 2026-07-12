# Experiment Cards

每个实验一个 Markdown 卡片，建议格式：

```text
# YYYY-MM-DD experiment name

## Hypothesis

## Data

## Metric

## Command

## Result

## Decision
```

规则：

- 没有明确指标的想法先进入 Idea Tree，不直接训练。
- 用 B_dev 调参，不用 B_test 日常迭代。
- 任何长训练、下载、包安装、GPU job 都先征得用户同意。
- 产物放在 `output/` 或服务器 `/data/FrameCullModelLab/outputs/`，本目录只放卡片和索引。
