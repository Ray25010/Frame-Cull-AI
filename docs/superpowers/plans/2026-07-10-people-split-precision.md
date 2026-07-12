# People Split Precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce different-person cluster contamination and non-human face admissions while allowing uncertain samples to remain split or unassigned.

**Architecture:** Keep YuNet and SFace, first make preprocessing match the official model contract, then replace permissive single-link behavior with evidence-based automatic admission and clustering. A browser lab runner executes the production functions on a read-only development/holdout split and exports auditable artifacts.

**Tech Stack:** TypeScript, Vitest, Vite, ONNX Runtime Web, YuNet, SFace, Playwright/CDP, PowerShell.

---

### Task 1: Lock Model Preprocessing Contracts

**Files:**
- Create: `src/utils/sfacePreprocess.ts`
- Create: `src/utils/sfacePreprocess.test.ts`
- Modify: `src/workers/peopleSplit.worker.ts:616`

- [ ] **Step 1: Write a failing RGB tensor test**

Create a pure helper test using one pixel with `R=11`, `G=22`, `B=33` and
assert the CHW tensor planes are `[11]`, `[22]`, `[33]`.

- [ ] **Step 2: Verify the test fails**

Run: `pnpm exec vitest run src/utils/sfacePreprocess.test.ts`

Expected: FAIL because `rgbaToSfaceChw` does not exist.

- [ ] **Step 3: Implement the pure RGB conversion helper**

Expose `rgbaToSfaceChw(data, size)` and keep resize/canvas work in the worker.
Write red, green, and blue values to consecutive CHW planes without mean or
scale normalization, matching OpenCV `blobFromImage(..., swapRB=true)`.

- [ ] **Step 4: Route the worker through the helper**

Replace the worker's inline BGR loop with `rgbaToSfaceChw` and bump
`PEOPLE_SPLIT_MODEL_VERSION` so stale in-memory results cannot be reused.

- [ ] **Step 5: Verify focused tests**

Run: `pnpm exec vitest run src/utils/sfacePreprocess.test.ts src/utils/peopleSplit.test.ts`

Expected: all tests pass.

### Task 2: Require Supported Cluster Merges

**Files:**
- Modify: `src/utils/peopleSplit.ts:301`
- Modify: `src/utils/peopleSplit.test.ts:93`

- [ ] **Step 1: Write a contamination regression test**

Build two multi-face clusters where one cross-cluster pair is close but the
centroids and remaining representative pairs are different. Assert the result
retains two clusters.

- [ ] **Step 2: Verify the regression fails**

Run: `pnpm exec vitest run src/utils/peopleSplit.test.ts`

Expected: FAIL because the current best-pair fallback merges the clusters.

- [ ] **Step 3: Implement merge evidence**

Compute centroid distance plus bidirectional representative support. Require a
strict centroid match, or at least two mutually supported representative faces
with no same-photo conflict. Remove `bestPairDistance + 0.04` as an independent
merge trigger.

- [ ] **Step 4: Add ambiguity-aware assignment regression**

Create a face with nearly equal distance to two clusters and assert it remains
unassigned instead of joining either cluster.

- [ ] **Step 5: Implement best-vs-second-best margin**

Seed with reliable faces, compare the two nearest candidate clusters, and only
assign when the best distance passes the strict threshold and clears the
configured margin. Preserve the face in `unassignedFaces` otherwise.

- [ ] **Step 6: Verify clustering tests**

Run: `pnpm exec vitest run src/utils/peopleSplit.test.ts`

Expected: all clustering tests pass, including same-person post-merge coverage.

### Task 3: Separate Display From Automatic Admission

**Files:**
- Modify: `src/utils/peopleSplit.ts:229`
- Modify: `src/utils/peopleSplit.test.ts`
- Modify: `src/workers/peopleSplit.worker.ts:149`
- Test: `src/utils/faceContentValidation.test.ts`

- [ ] **Step 1: Add admission boundary tests**

Cover a low-confidence but displayable candidate, a strong landmarked face, and
a wheel-like detector hit. Assert only the strong face is auto-eligible.

- [ ] **Step 2: Verify the new tests fail where expected**

Run: `pnpm exec vitest run src/utils/peopleSplit.test.ts src/utils/faceContentValidation.test.ts`

- [ ] **Step 3: Tighten automatic admission only**

Keep review visibility around the existing detector threshold, but require
stronger detector confidence, five keypoints, structure quality, visual
quality, and content plausibility for automatic clustering. Do not globally
raise YuNet to `0.9`, because that would hide difficult real faces instead of
placing them in review.

- [ ] **Step 4: Preserve rejection diagnostics**

Assign a concrete reason to every review-only candidate so benchmark contact
sheets can separate confidence, structure, blur, crop, and content failures.

- [ ] **Step 5: Verify focused tests**

Run: `pnpm exec vitest run src/utils/peopleSplit.test.ts src/utils/faceContentValidation.test.ts src/utils/faceDetectionGeometry.test.ts`

Expected: all tests pass.

### Task 4: Add Read-Only People Split Benchmark

**Files:**
- Create: `tools/ai-lab/people-split-precision.html`
- Create: `tools/ai-lab/people-split-precision-runner.ts`
- Create: `tools/ai-lab/run-people-split-precision-cdp.mjs`
- Create: `tools/ai-lab/write-people-split-precision-report.mjs`
- Modify: `tools/ai-lab/README.md`

- [ ] **Step 1: Add runner unit tests for summary calculations**

Extract pure summary functions and test photo counts, worker failures,
accepted/review/rejected counts, cluster sizes, and distance quantiles.

- [ ] **Step 2: Verify tests fail before implementation**

Run the focused Vitest file and confirm missing exports cause the failure.

- [ ] **Step 3: Implement the browser runner**

Load image files supplied through the CDP file input, run the production
people-split worker, and export per-face diagnostics, normalized embeddings,
and cluster membership. Never write to the source folder.

- [ ] **Step 4: Implement the CDP wrapper**

Accept `--input`, `--output`, and `--label`; use installed Edge, a local Vite
server, deterministic filename ordering, bounded concurrency, and separate
stdout/stderr logs.

- [ ] **Step 5: Generate contact sheets and report inputs**

Create cluster and rejected-candidate manifests under the requested output
directory. Store paths to source files rather than copying all 6.58 GB.

- [ ] **Step 6: Smoke test on ten development images**

Expected: ten photos accounted for, zero silent failures, and JSON artifacts
containing candidate and cluster diagnostics.

### Task 5: Development Calibration And Holdout Verification

**Files:**
- Create: `output/people-split-precision/dev-baseline/`
- Create: `output/people-split-precision/dev-candidate/`
- Create: `output/people-split-precision/holdout-final/`
- Create: `output/people-split-precision/final-report.md`

- [ ] **Step 1: Capture the unchanged development baseline**

Run all 272 files in `新建文件夹 (10)` and retain raw diagnostics and contact
sheets.

- [ ] **Step 2: Review baseline B/D errors**

Mark false detections and mixed-identity clusters in a separate manifest. Keep
source images read-only.

- [ ] **Step 3: Run one-change-at-a-time ablations**

Compare RGB correction, admission gates, ambiguity margin, and supported merge
using the same development review manifest. Freeze thresholds only after the
development metrics favor B/D precision.

- [ ] **Step 4: Run the locked holdout once**

Run all 227 files in `新建文件夹 (11)` with frozen settings. Do not adjust
thresholds after viewing holdout outcomes.

- [ ] **Step 5: Write the final report**

Report mixed clusters, foreign-face rate, false-face admissions, unassigned
growth, cluster count, processed/failed photos, runtime, and remaining failure
examples for baseline and candidate.

### Task 6: Final Verification

**Files:**
- Verify all files modified above.

- [ ] **Step 1: Run focused people split tests**

Run: `pnpm exec vitest run src/utils/sfacePreprocess.test.ts src/utils/peopleSplit.test.ts src/utils/faceContentValidation.test.ts src/utils/faceDetectionGeometry.test.ts`

- [ ] **Step 2: Run the TypeScript compiler**

Run: `pnpm exec tsc --noEmit`

- [ ] **Step 3: Build Flash and Pro frontends**

Run: `pnpm run build:flash`

Run: `pnpm run build:pro`

- [ ] **Step 4: Audit the final diff**

Confirm no source photo changed, no macOS work was added, no NEF work was
reverted, and all generated artifacts remain under
`output/people-split-precision/`.
