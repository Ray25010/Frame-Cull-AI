# macOS Test Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce GitHub Actions macOS Flash test packages for Apple Silicon and Intel with a scoped first-launch helper.

**Architecture:** A dedicated workflow builds the existing Tauri Flash configuration on GitHub macOS runners, stages the DMG with tester instructions, creates a Finder-friendly ZIP, and uploads it as an Actions artifact. The helper removes quarantine only from the installed FrameCull app and never changes global Gatekeeper settings.

**Tech Stack:** GitHub Actions, Tauri 2, Rust, pnpm, zsh, macOS `codesign`, `xattr`, `ditto`.

---

### Task 1: Restore Reproducible Dependency Installation

**Files:**
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Reproduce the CI lockfile failure**

Run: `CI=true pnpm install --frozen-lockfile`

Expected: FAIL with the lockfile override configuration mismatch.

- [ ] **Step 2: Regenerate only the lockfile metadata**

Run: `CI=true pnpm install --lockfile-only --no-frozen-lockfile`

Expected: `pnpm-lock.yaml` records the overrides from `package.json` without
changing declared dependencies.

- [ ] **Step 3: Verify frozen installation**

Run: `CI=true pnpm install --frozen-lockfile`

Expected: PASS.

### Task 2: Remove TypeScript Build Blockers

**Files:**
- Modify: `src/utils/peopleSplit.test.ts`

- [ ] **Step 1: Preserve the failing compiler evidence**

Run: `pnpm exec tsc --noEmit`

Expected: FAIL with `TS2783` for duplicate `quality` properties.

- [ ] **Step 2: Keep each intended quality override once**

Move explicit `quality` values after `...stableFaceSample`, or omit the
explicit value when it matches the shared sample. Do not change test vectors or
clustering expectations.

- [ ] **Step 3: Verify focused tests and compiler**

Run: `pnpm exec vitest run src/utils/peopleSplit.test.ts`

Run: `pnpm exec tsc --noEmit`

Expected: PASS.

### Task 3: Add Scoped First-Launch Helper

**Files:**
- Create: `tools/macos/FrameCull-First-Launch.command`
- Create: `tools/macos/README-macOS-first-launch.txt`

- [ ] **Step 1: Implement the helper**

Use zsh with `set -euo pipefail`. Require
`/Applications/FrameCull AI Flash.app`, run
`/usr/bin/xattr -dr com.apple.quarantine` only on that path, and open it with
`/usr/bin/open`. Do not use `sudo` or change `spctl`.

- [ ] **Step 2: Add tester instructions**

Explain normal DMG installation first, then the fallback helper flow, the
right-click Open requirement for the helper itself, and the fact that this is
an internal unnotarized test package.

- [ ] **Step 3: Validate script syntax where possible**

Run on GitHub macOS: `/bin/zsh -n tools/macos/FrameCull-First-Launch.command`.

Expected: PASS.

### Task 4: Add macOS Test Build Workflow

**Files:**
- Create: `.github/workflows/macos-test-build.yml`

- [ ] **Step 1: Define a manual two-target matrix**

Use `workflow_dispatch` with `aarch64-apple-darwin` and
`x86_64-apple-darwin`. Keep release publishing and Apple credentials out of
this workflow.

- [ ] **Step 2: Build ad-hoc signed Flash bundles**

Set `APPLE_SIGNING_IDENTITY=-` and run
`pnpm exec tauri build --features default --config src-tauri/tauri.flash.conf.json --target <target>`.
Passing the explicit default feature set prevents Tauri from trying to bundle
the `pro-infer-bench` binary, whose required `pro` feature is disabled in Flash.

- [ ] **Step 3: Stage and verify artifacts**

Find the generated DMG, copy it with the helper and README into an
architecture-specific directory, inspect the app bundle with `codesign` when
present, and generate `SHA256SUMS.txt`.

- [ ] **Step 4: Preserve executable metadata**

Run `chmod +x` on the helper and package the staged directory with `ditto`.
Upload the resulting ZIP with `actions/upload-artifact`.

### Task 5: Verify And Trigger GitHub Build

**Files:**
- Verify all files above and the existing people-split/NEF working changes.

- [ ] **Step 1: Run local verification**

Run focused Vitest, `pnpm exec tsc --noEmit`, and
`pnpm run build:release:flash`.

- [ ] **Step 2: Review the complete diff**

Confirm no source photos or generated benchmark outputs are staged, and the
helper cannot affect apps other than FrameCull AI Flash.

- [ ] **Step 3: Commit and push the current branch**

Commit the validated current working changes plus macOS workflow support, then
push `codex/pro-flash-0.1.6-update`.

- [ ] **Step 4: Trigger and monitor the workflow**

Run: `gh workflow run macos-test-build.yml --ref codex/pro-flash-0.1.6-update`

Monitor with `gh run watch <run-id> --exit-status`.

- [ ] **Step 5: Download and inspect artifacts**

Download both workflow artifacts, list their ZIP contents, confirm required
files exist, and report the tester distribution paths.
