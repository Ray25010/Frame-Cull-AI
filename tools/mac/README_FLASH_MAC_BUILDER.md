# FrameCull AI Flash macOS Builder

This folder contains a reusable macOS build helper for `FrameCull AI Flash`.

## What It Does

`FrameCullFlashMacBuilder.command` is a double-clickable macOS build helper. It opens native macOS dialogs to choose:

- a FrameCull source folder or source archive (`.zip`, `.tar`, `.tar.gz`, `.tgz`)
- an output folder
- the target architecture
- whether to run tests

It builds only `FrameCull AI Flash`, then copies the generated `.dmg` and `.app` into a timestamped output folder.

## First-Time Setup On The Mac

The builder can install most missing dependencies on the spot. A Mac with internet access is required.

It can install or enable:

- Homebrew
- Node.js
- pnpm
- Rust / cargo / rustup

Xcode Command Line Tools are a macOS system package. If they are missing, the builder opens Apple's installer and asks you to run the builder again after installation finishes.

Manual setup is still possible:

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
corepack enable
corepack prepare pnpm@latest --activate
```

If the `.command` file cannot be opened by double-clicking, run this once:

```bash
chmod +x tools/mac/FrameCullFlashMacBuilder.command
```

Then double-click:

```text
tools/mac/FrameCullFlashMacBuilder.command
```

## Recommended Source Package

Send a source `.zip` that includes:

- `package.json`
- `pnpm-lock.yaml`
- `src/`
- `src-tauri/`
- `tools/`

Do not include:

- `node_modules/`
- `dist/`
- `src-tauri/target/`

The helper builds in a temporary workspace, so the selected source package is not modified.

## Output

The helper creates a folder like:

```text
FrameCull-AI-Flash-macOS-20260619-153000/
```

Inside it:

- `.dmg`
- `.app`
- `build.log`

If the build fails, the dialog points to `build.log`, and the temporary build directory is kept for debugging.

## Signing And Notarization

This helper creates a local macOS build. For public distribution outside your own test machine, use Apple Developer ID signing and notarization in a later release step.
