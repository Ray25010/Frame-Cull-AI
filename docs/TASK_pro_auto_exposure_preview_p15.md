# FrameCull Pro Auto Exposure Preview P1.5

## Background
The real product goal of RAW preview is not to replace a full RAW developer.
The goal is to answer this culling question quickly:

> If this RAW frame is auto-exposed, is it still worth keeping?

P1 showed that Nikon High Efficiency Star NEF can provide a valid embedded
preview, but cannot currently be fully raw-developed through the isolated
`rawler` experiment. Therefore P1.5 focuses on fast auto-exposure preview over a
safe display source.

## Product Strategy
- Do not block navigation.
- Show the normal preview first.
- When Pro auto exposure preview is enabled, prefer a fast safe preview source.
- High quality RAW develop remains an async enhancement or fallback path.
- Failures must fall back to the normal preview and must never show corrupted
  images.

## Scope
### In
- Use the existing native embedded RAW preview extraction path.
- Apply EXIF orientation through the existing preview cache.
- Compute luma percentiles from the display preview:
  - shadow percentile
  - midtone percentile
  - highlight percentile
  - clipped highlight ratio
- Generate conservative `autoExposureEv`:
  - protect highlights first
  - do not turn dark mood / night scenes into daylight
  - clamp EV so compensation stays modest
- Apply the preview non-destructively in the viewer.
- Do not write metadata, XMP, or source files.
- Produce experiment metrics and an Arbor report.

### Out
- Do not add this to Flash as a heavy RAW/GPU dependency.
- Do not ship `rawler` or `wgpu` in the app bundle for this round.
- Do not replace the RawTherapee monitor cache path as the only path.
- Do not claim embedded JPEG can recover true RAW highlight detail.
- Do not attempt full camera color management.

## Preview Levels
### Fast Preview
Input: embedded RAW JPEG or current display preview.

Purpose: quickly judge the look after auto exposure.

Strengths: stable, fast, safe for culling.

Limit: cannot recover true RAW dynamic range.

### High Fidelity Preview
Input: true linear RAW develop.

Purpose: closer to Lightroom / Camera Raw.

Strengths: can use RAW dynamic range.

Limit: Nikon High Efficiency Star support is not stable in the current decoder
path, and RawTherapee is slower as an external process.

## Acceptance
- Nikon NEF no longer shows rainbow bands or pink blocks when this path is used.
- Auto exposure preview does not wait for slow RAW develop.
- Failure always falls back to normal preview.
- Flash build remains free of Pro RAW / GPU experiment dependencies.
- P1.5 report includes preview timing, EV, highlight clipping, and fallback
  reason.
