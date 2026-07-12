# FrameCull Pro RAW Preview Lab P1

This is an isolated experiment for Pro native RAW preview decoding.

It is intentionally outside `src-tauri/Cargo.toml`, so `rawler` and lab-only
dependencies do not enter Flash or the packaged Pro app.

Smoke command:

```powershell
cargo run --manifest-path tools/pro-raw-preview-lab/Cargo.toml --release -- `
  --input G:\DCIM\110NZ6_3\_DSC0552.NEF `
  --output output\pro-raw-preview-lab\p1-smoke
```

Outputs:

- `metrics.json`
- `summary.md`
- `*.embedded.jpg`
- `*.raw-develop.jpg`
