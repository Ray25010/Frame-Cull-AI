# Protected Paths

这个研发工作区的第一条规则是：不把研发整理动作混进软件开发主体。

## 不在本工作区任务里改

- `src/`
- `src-tauri/src/`
- `src-tauri/tauri*.conf.json`
- `package.json`
- `pnpm-lock.yaml`
- `README.md`
- `docs/README_CN.md`
- 外部原始数据目录，例如 `D:\FrameCullRawAudit\...`
- 服务器 `/data/FrameCullModelLab/...` 原始数据，除非用户明确要求同步或归档

## 可以改

- `research/arbor-framecull-lab/**`

## 可以引用但不移动

- `docs/GOAL_pro_semantic_teacher_lab.md`
- `docs/TASK_fix_semantic_false_face.md`
- `docs/TASK_close_false_face_evidence.md`
- `output/paper-artifacts/semantic-teacher-lab/**`
- `output/semantic-false-face-diagnosis/**`
- `output/pro-models/**`
- `output/ai-bench/**`
