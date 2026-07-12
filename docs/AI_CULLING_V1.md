# FrameCull AI Culling v1

This note records the local AI culling features, workflow boundaries, export behavior, and current verification status for this branch.

## Scope

FrameCull AI Culling v1 keeps the existing manual review workflow, RAW+JPG grouping, import, Pick/Reject, delete, and source-format export features. It adds local hard-fault screening for:

- Out of focus: face ROI first; center-weighted ROI when no face is found.
- Obvious underexposure: luma mean, dark clipping, and subject-region luma.
- Obvious overexposure: highlight clipping, subject highlight clipping, and subject-region luma.
- Eyes closed: local MediaPipe Face Landmarker model, blink blendshapes first and eye aspect ratio fallback.

AI writes only to `PhotoGroup.ai`. It never deletes files, moves files, or overwrites the final manual decision. `selection` changes only after a manual review action or the existing manual keyboard shortcuts.

Face detection is attempted for any enabled hard-fault check, including exposure-only presets, so portrait exposure checks can use a face ROI instead of falling back to the center crop when the face model is available.

## Local Model Assets

Runtime model assets live under:

- `public/models/mediapipe/face_landmarker/face_landmarker.task`
- `public/models/mediapipe/wasm/*`

The production build copies them to `dist/models/mediapipe/`. The AI worker loads model assets only from the current app origin at `/models/mediapipe/...`; no cloud AI API is used at runtime.

## Workflow

1. Import files or a folder. FrameCull AI still groups RAW+JPG by base filename.
2. Click the AI culling button to start the local queue.
3. The toolbar shows progress and supports pause/resume.
4. The main viewer shows issue labels above the photo, for example `Out of focus 82%`.
5. Thumbnails show concrete AI issue badges.
6. The AI review filter shows only photos with AI issues that have not been manually reviewed.
7. The right review panel shows reason, confidence, metrics, detection region, and model version.
8. Manual AI review actions:
   - Keep -> `selection = PICKED`, `ai.reviewed = true`
   - Reject -> `selection = REJECTED`, `ai.reviewed = true`
   - Undecided -> `selection = UNMARKED`, `ai.reviewed = false`

## Settings

The AI settings panel provides independent enable switches for:

- Out of focus
- Underexposed
- Overexposed
- Eyes closed

Each check supports `weak`, `standard`, and `strong` sensitivity. The global sensitivity control syncs all checks. Defaults are all checks enabled with standard sensitivity.

RAW grouping and decoding paths cover common formats listed by the app docs: ARW, CR2, CR3, NEF, NRW, DNG, ORF, RAF, RW2, SRW, SRF, and SR2.

## Export

Export processes only photos where `selection = PICKED`.

- Source JPG / RAW / RAW+JPG: copies or moves original files and preserves original file contents and metadata. Filename conflicts are resolved by appending a number.
- Rendered JPG / TIFF: renders a new pixel file from the JPG or RAW-decoded preview, then asks Tauri to write it to disk.

Limitation: source-format export preserves full original files. RAW rendered to JPG/TIFF does not guarantee full RAW metadata.

In the desktop runtime, AI analysis and rendered export read selected JPG bytes through the Tauri filesystem plugin before falling back to preview URLs. Dialog-selected files and folders are added to the Tauri filesystem and asset scopes; folder import requests recursive scope for later reads.

## Verification

Verified in this environment:

- `pnpm run test`: 12 tests covering settings normalization, thresholds, cache keys, face-detection gating, AI review transitions, and metric-based classification for the four hard faults.
- `pnpm run build`: TypeScript and Vite production build.
- Local dev server serves the MediaPipe model and wasm assets.
- Browser smoke test: main UI and AI settings panel open without new console errors.
- Browser demo smoke test: flagged photos show main-stage AI labels, thumbnail badges, and review actions; clear photos show no review actions.
- Business code scan found no cloud AI API, API key, OpenAI, or Gemini dependency.
- `cargo check --manifest-path src-tauri/Cargo.toml`: Tauri backend compiles.
- `pnpm tauri build`: Windows desktop build and bundling complete.

Build environment installed in this environment:

- Rustup 1.29.0 with `stable-x86_64-pc-windows-msvc`.
- `rustc` 1.96.0 and `cargo` 1.96.0.
- Visual Studio Build Tools 2022 with MSVC.

Generated Windows bundles:

- `src-tauri/target/release/bundle/msi/framecull-ai_0.1.1_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/framecull-ai_0.1.1_x64-setup.exe`
