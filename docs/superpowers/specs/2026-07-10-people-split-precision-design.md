# People Split Precision Design

## Goal

Improve People Split precision for the two user-reported failure modes:

- B: different people are merged into one automatic cluster.
- D: objects or background patterns are shown as faces.

The optimization is precision-first. Ambiguous samples may remain unassigned or
temporarily split into multiple clusters rather than contaminating a person
cluster.

## Evaluation Boundary

The source corpus is read-only:

`C:\Users\29238\Desktop\26.6.7研学`

- `新建文件夹 (10)`: development and threshold calibration set, 272 JPG files.
- `新建文件夹 (11)`: locked holdout set, 227 JPG files.
- Neither folder is used to train a model.
- Holdout results are inspected only after the implementation and development
  thresholds are frozen.
- Generated manifests, embeddings, contact sheets, and reports live under
  `output/people-split-precision/`; original photos are never modified.

## Success Metrics

The primary metric is automatic-cluster purity.

- `foreign-face clusters`: automatic clusters containing more than one real
  identity. Target: zero on the reviewed holdout clusters.
- `foreign-face rate`: faces assigned to a cluster whose majority identity is
  different. Target: zero on reviewed holdout faces.
- `false-face accepted`: non-human detections admitted to an automatic person
  cluster. Target: zero on the reviewed holdout.

Secondary guardrails:

- Report unassigned-face count and singleton/split growth explicitly.
- Do not recover recall by weakening the B or D precision gates.
- Record runtime and worker failures so an apparent precision gain cannot come
  from silently skipping photos.

## Root Causes To Address

### SFace input mismatch

The shipped SFace ONNX worker currently writes aligned image channels as BGR.
OpenCV `FaceRecognizerSF::feature` calls `blobFromImage(..., swapRB=true)`, so
the model receives RGB. The browser implementation must match that reference.
Incorrect channel ordering can degrade identity embeddings and narrow the gap
between same-person and different-person distances.

### Permissive face admission

The full-frame YuNet confidence threshold is `0.48`, while downstream gates
partly rely on handcrafted content scores. This admits low-confidence
face-shaped objects. Detection and automatic-cluster admission should be
separate: questionable candidates may be visible for review, but only strongly
confirmed faces can enter automatic identity clusters.

### Single-link cluster contamination

The post-merge path can merge two complete clusters when one sampled face pair
is close enough. One poor embedding can therefore contaminate an otherwise
clean cluster. Automatic merging must require agreement from cluster centroids
and multiple representative comparisons, with explicit rejection of ambiguous
matches.

## Proposed Pipeline

1. Detect candidates with YuNet and preserve five keypoints.
2. Apply existing content validation, then classify each candidate as:
   `AUTO_ELIGIBLE`, `REVIEW_ONLY`, or rejected.
3. Align faces with the official SFace five-point template.
4. Feed SFace RGB tensors matching OpenCV's reference preprocessing.
5. Build conservative seed clusters from high-quality faces.
6. Assign a face only when its best cluster passes the strict threshold and is
   separated from the second-best cluster by a minimum ambiguity margin.
7. Post-merge clusters only when centroid similarity and representative-pair
   support agree; a single close pair is insufficient.
8. Keep all uncertain detections and identities in the unassigned review area.

## Benchmark Artifacts

The browser benchmark exports:

- per-photo candidate boxes, confidence, keypoints, quality, and rejection
  reason;
- normalized SFace embeddings for accepted real-face candidates;
- cluster membership and the distances that justified each assignment/merge;
- contact sheets for automatic clusters and rejected/uncertain detections;
- a machine-readable summary comparing baseline and candidate configurations.

The benchmark reuses the same worker preprocessing and clustering utilities as
production so lab results cannot drift into a separate implementation.

## Delivery Order

1. Add regression tests for official RGB preprocessing and conservative merge
   evidence.
2. Add a read-only browser benchmark/export path.
3. Capture the baseline on development set `(10)`.
4. Apply one change at a time: RGB preprocessing, automatic-face admission,
   ambiguity-aware assignment, then supported cluster merge.
5. Freeze thresholds on `(10)` and run one final holdout pass on `(11)`.
6. Ship only changes that improve B/D precision without hidden processing
   failures; otherwise report the remaining limitation and evaluate a second
   identity model as a separate phase.

## Non-Goals

- Training or fine-tuning SFace or the semantic student.
- Optimizing same-person recall at the expense of cluster purity.
- Modifying the source photos.
- Starting macOS packaging work in this phase.
