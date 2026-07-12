# Benchmark Entry Points

这个目录只记录 benchmark 入口，不保存大数据。

## Cached / Cheap

- false-face closure: `../../output/semantic-false-face-diagnosis/v11-final/false-face-delta-summary.json`
- paper summary: `../../output/paper-artifacts/semantic-teacher-lab/latest-paper-summary.md`

## Potential Real Eval

- Pro persona eval: `../../tools/ai-lab/bench-pro-persona.mjs`
- Pro semantic student eval: `../../tools/ai-lab/bench-pro-semantic-student.mjs`
- supervised pick tuning: `../../tools/ai-lab/tune-ai-picks-supervised.mjs`

Real eval may run browser inference, model inference, or server jobs. Do not run it from Arbor setup without explicit approval.
