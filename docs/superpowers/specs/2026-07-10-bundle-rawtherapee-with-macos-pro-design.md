# Bundle RawTherapee With macOS Pro Design

## Goal

Make both FrameCull AI Pro macOS tester ZIPs self-contained for downloading:
each outer ZIP includes the official RawTherapee 5.12 macOS Universal installer
ZIP alongside the FrameCull Pro DMG, first-launch helper, Chinese instructions,
and checksums.

The tester still installs RawTherapee by extracting its included ZIP and
dragging `RawTherapee.app` into `/Applications`. No additional network download
is required after receiving the FrameCull Pro package.

## Distribution Boundary

- Preserve the official RawTherapee archive byte-for-byte instead of extracting
  or re-signing `RawTherapee.app` during FrameCull packaging.
- Do not embed RawTherapee inside `FrameCull AI Pro.app` or its DMG.
- Do not automate copying RawTherapee into `/Applications`.
- Do not remove quarantine from RawTherapee in the FrameCull first-launch
  helper; that helper remains scoped to `/Applications/FrameCull AI Pro.app`.
- Keep the existing ad-hoc FrameCull signing boundary unchanged.
- Expect each Pro tester ZIP to grow by approximately 181 MB before outer ZIP
  overhead.

## Pinned Upstream Artifact

- Product: RawTherapee 5.12 macOS Universal
- Artifact: `RawTherapee_macOS_15.4_Universal_5.12.zip`
- Release: `https://github.com/RawTherapee/RawTherapee/releases/tag/5.12`
- Download: `https://github.com/RawTherapee/RawTherapee/releases/download/5.12/RawTherapee_macOS_15.4_Universal_5.12.zip`
- SHA-256: `2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688`

Store this provenance in a small tracked JSON manifest. The 181 MB upstream
archive remains a CI download and must not be committed to Git.

## Workflow

1. Each Pro matrix job reads the tracked RawTherapee provenance manifest.
2. The job downloads the official archive with retry handling.
3. `shasum -a 256 --check` verifies the pinned upstream digest before staging.
4. The unchanged archive is copied into the architecture-specific Pro staging
   directory.
5. `SHA256SUMS.txt` covers the FrameCull DMG, RawTherapee installer ZIP,
   first-launch helper, and Chinese README.
6. The existing `ditto` step creates the final outer Pro ZIP.
7. The Draft Release continues to receive one arm64 and one x64 Pro ZIP.

Any download, digest, file-presence, or checksum failure stops that matrix job
and prevents Draft Release creation.

## Tester Experience

The Chinese README presents this order:

1. Extract the FrameCull Pro tester ZIP.
2. Extract the included RawTherapee Universal ZIP.
3. Drag `RawTherapee.app` into `/Applications` and open it once if macOS asks
   for confirmation.
4. Open the FrameCull Pro DMG and drag `FrameCull AI Pro.app` into
   `/Applications`.
5. Start FrameCull Pro; it automatically probes
   `/Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli`.
6. Use the scoped FrameCull first-launch helper only when Gatekeeper blocks the
   unnotarized FrameCull test app.

## Validation

- A pre-change contract check proves the current Pro ZIP lacks the RawTherapee
  installer.
- Local static checks validate the provenance manifest, workflow syntax, and
  updated README text.
- Both GitHub macOS matrix jobs verify the upstream SHA before packaging.
- The packaging job asserts the RawTherapee archive exists in each staged ZIP
  and includes it in `SHA256SUMS.txt`.
- Download both new Draft Release assets to a new desktop run directory.
- Confirm GitHub asset digests match local ZIP SHA-256 values.
- Extract both outer ZIPs and verify every internal checksum, including the
  bundled RawTherapee archive.
- Confirm the package still contains `FrameCull AI Pro`, never Flash, and that
  the first-launch helper remains executable and FrameCull-only.

## Success Criteria

Both downloadable Pro ZIPs contain the pinned official RawTherapee Universal
installer and pass all existing Pro identity, model, architecture, runtime,
signature, and checksum gates. A tester can install both applications without
performing another download.
