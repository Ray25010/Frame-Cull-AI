# macOS Test Build Design

## Goal

Produce downloadable FrameCull AI Flash test packages for Apple Silicon and
Intel Macs using GitHub-hosted macOS runners.

The immediate tester build does not have Apple Developer Program credentials,
so it cannot be Developer ID signed or notarized. It will instead use ad-hoc
signing and include an explicit, user-invoked helper that removes quarantine
only from the installed FrameCull application.

## Distribution Boundary

- Build `FrameCull AI Flash` for `aarch64-apple-darwin` and
  `x86_64-apple-darwin`.
- Upload GitHub Actions artifacts rather than publishing a public release.
- Package each architecture as a ZIP containing the generated DMG, the helper
  command, Chinese instructions, and SHA-256 checksums.
- Do not disable Gatekeeper globally and do not use `sudo`.
- The helper may only remove `com.apple.quarantine` from
  `/Applications/FrameCull AI Flash.app`, then open that application.
- A future public release still requires Developer ID signing, notarization,
  and stapling through paid Apple Developer credentials.

## Workflow

1. Install Node.js, pnpm, Rust, and the matrix Rust target on a GitHub macOS
   runner.
2. Install dependencies with the frozen lockfile.
3. Build the Flash Tauri application for the selected target with
   `APPLE_SIGNING_IDENTITY=-` for ad-hoc signing.
4. Locate the generated DMG and stage it with the helper and instructions.
5. Verify the app bundle signature when available, generate checksums, and use
   `ditto` to create a Finder-friendly ZIP.
6. Upload the ZIP as a GitHub Actions artifact.

## Known Blockers

- The committed lockfile lacks the current package override snapshot, causing
  `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` in CI.
- `src/utils/peopleSplit.test.ts` repeats the `quality` property around object
  spreads, causing `tsc --noEmit` to fail before the Tauri build starts.

## Validation

- `CI=true pnpm install --frozen-lockfile` succeeds locally.
- Focused Vitest and `tsc --noEmit` pass.
- `pnpm run build:release:flash` succeeds on Windows as a frontend check.
- Both GitHub macOS matrix jobs finish successfully and expose downloadable ZIP
  artifacts.
- Downloaded ZIPs contain one DMG, the helper, instructions, and checksums.
