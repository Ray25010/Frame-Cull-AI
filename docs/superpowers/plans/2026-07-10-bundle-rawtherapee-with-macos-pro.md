# Bundle RawTherapee With macOS Pro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include the pinned official RawTherapee 5.12 macOS Universal installer ZIP in both downloadable FrameCull AI Pro macOS tester ZIPs.

**Architecture:** Keep RawTherapee as its untouched upstream ZIP beside the FrameCull Pro DMG in the outer tester package. A tracked provenance manifest supplies the official URL and SHA-256; each macOS matrix job downloads and verifies that artifact before staging, then the existing package checksum file covers it with the DMG and tester documentation.

**Tech Stack:** GitHub Actions, Tauri 2, pnpm, Node.js, bash, macOS `shasum`, `ditto`, GitHub CLI.

---

### Task 1: Prove The Current Package Is Missing RawTherapee

**Files:**
- Inspect: `C:/Users/29238/Desktop/FrameCull-Pro-macOS-Test-0.1.6-run-29102039690/FrameCull-Pro-macOS-arm64.zip`
- Inspect: `C:/Users/29238/Desktop/FrameCull-Pro-macOS-Test-0.1.6-run-29102039690/FrameCull-Pro-macOS-x64.zip`

- [ ] **Step 1: Run the pre-change package contract**

```powershell
$root = 'C:\Users\29238\Desktop\FrameCull-Pro-macOS-Test-0.1.6-run-29102039690'
foreach ($arch in @('arm64', 'x64')) {
  $zip = Join-Path $root "FrameCull-Pro-macOS-$arch.zip"
  $entries = tar -tf $zip
  if ($entries -notmatch 'RawTherapee_macOS_15.4_Universal_5.12.zip') {
    Write-Error "$arch package does not include RawTherapee"
  }
}
```

Expected: FAIL for both architectures because the current Pro ZIPs only contain
the FrameCull DMG, helper, README, and checksum file.

### Task 2: Add Auditable RawTherapee Provenance And Instructions

**Files:**
- Create: `src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json`
- Modify: `tools/macos/README-FrameCull-Pro-macOS-first-launch.txt`

- [ ] **Step 1: Add the pinned upstream manifest**

Create this exact structured manifest:

```json
{
  "schemaVersion": 1,
  "name": "RawTherapee",
  "version": "5.12",
  "platform": "macos-universal",
  "artifact": "RawTherapee_macOS_15.4_Universal_5.12.zip",
  "sourceUrl": "https://github.com/RawTherapee/RawTherapee/releases/download/5.12/RawTherapee_macOS_15.4_Universal_5.12.zip",
  "checksumUrl": "https://github.com/RawTherapee/RawTherapee/releases/download/5.12/RawTherapee_macOS_15.4_Universal_5.12.zip.sha256",
  "releaseUrl": "https://github.com/RawTherapee/RawTherapee/releases/tag/5.12",
  "sha256": "2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688"
}
```

- [ ] **Step 2: Update the Chinese tester flow**

Replace the current “install RawTherapee separately” wording with these concrete
steps while preserving the existing signing and Gatekeeper boundaries:

```text
安装随包附带的 RawTherapee：
1. 解压“RawTherapee_macOS_15.4_Universal_5.12.zip”。
2. 把“RawTherapee.app”拖入 Applications（应用程序）。
3. 首次打开若被 macOS 拦截，请右键“RawTherapee.app”并选择“打开”。
4. FrameCull AI Pro 会自动检测：
   /Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli
```

Also state that the same Universal installer supports Apple Silicon and Intel,
and that no additional RawTherapee download is required.

- [ ] **Step 3: Validate the manifest and documentation**

```powershell
node -e "const fs=require('node:fs');const p='src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json';const m=JSON.parse(fs.readFileSync(p,'utf8'));if(m.artifact!=='RawTherapee_macOS_15.4_Universal_5.12.zip'||m.sha256!=='2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688'||!m.sourceUrl.startsWith('https://github.com/RawTherapee/RawTherapee/releases/download/'))throw Error('invalid RawTherapee manifest');console.log('RawTherapee manifest: PASS')"
$readme = Get-Content -Raw -Encoding utf8 'tools\macos\README-FrameCull-Pro-macOS-first-launch.txt'
if ($readme -notmatch 'RawTherapee_macOS_15.4_Universal_5.12.zip' -or $readme -notmatch '/Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli') { exit 1 }
```

Expected: PASS.

- [ ] **Step 4: Commit provenance and instructions**

```powershell
git add src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json tools/macos/README-FrameCull-Pro-macOS-first-launch.txt
git commit -m "docs: include RawTherapee macOS installer guidance"
```

### Task 3: Download And Stage RawTherapee In Both Pro Packages

**Files:**
- Modify: `.github/workflows/macos-pro-test-build.yml`

- [ ] **Step 1: Extend the existing input validation**

Inside `Validate Pro package inputs`, parse
`src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json` and require
the exact artifact name, official GitHub release URL prefix, and pinned SHA:

```javascript
const rawTherapee = JSON.parse(
  fs.readFileSync(
    "src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json",
    "utf8",
  ),
);
if (rawTherapee.artifact !== "RawTherapee_macOS_15.4_Universal_5.12.zip") {
  throw new Error("wrong RawTherapee artifact");
}
if (!rawTherapee.sourceUrl.startsWith("https://github.com/RawTherapee/RawTherapee/releases/download/")) {
  throw new Error("RawTherapee source is not the official GitHub release");
}
if (rawTherapee.sha256 !== "2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688") {
  throw new Error("wrong RawTherapee SHA-256");
}
```

- [ ] **Step 2: Add an upstream download step**

Add this step after input validation and before the Tauri build so both matrix
jobs use the same pinned Universal archive:

```yaml
- name: Download official RawTherapee installer
  id: rawtherapee
  shell: bash
  run: |
    set -euo pipefail

    manifest="src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json"
    artifact="$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.artifact)' "${manifest}")"
    source_url="$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.sourceUrl)' "${manifest}")"
    expected_sha="$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.sha256)' "${manifest}")"
    archive="${RUNNER_TEMP}/${artifact}"

    curl --fail --location --retry 3 --output "${archive}" "${source_url}"
    echo "${expected_sha}  ${archive}" | /usr/bin/shasum -a 256 --check
    echo "archive_path=${archive}" >> "${GITHUB_OUTPUT}"
    echo "artifact_name=${artifact}" >> "${GITHUB_OUTPUT}"
```

- [ ] **Step 3: Add RawTherapee to the staged ZIP contract**

Expose the step outputs to `Stage and verify Pro tester package`:

```yaml
RAWTHERAPEE_ARCHIVE: ${{ steps.rawtherapee.outputs.archive_path }}
RAWTHERAPEE_ARTIFACT: ${{ steps.rawtherapee.outputs.artifact_name }}
```

Then require and copy the untouched archive:

```bash
test -f "${RAWTHERAPEE_ARCHIVE}"
test "$(basename "${RAWTHERAPEE_ARCHIVE}")" = "${RAWTHERAPEE_ARTIFACT}"
cp "${RAWTHERAPEE_ARCHIVE}" "${stage_dir}/${RAWTHERAPEE_ARTIFACT}"
```

Generate checksums over all staged payloads:

```bash
/usr/bin/shasum -a 256 ./*.dmg "${RAWTHERAPEE_ARTIFACT}" FrameCull-Pro-First-Launch.command README-FrameCull-Pro-macOS-first-launch.txt > SHA256SUMS.txt
```

- [ ] **Step 4: Update Draft Release notes**

State that each Pro ZIP includes the pinned official RawTherapee 5.12 macOS
Universal installer and its checksum coverage. Do not claim RawTherapee is
embedded or automatically installed.

- [ ] **Step 5: Validate workflow syntax and diff**

```powershell
pnpm dlx prettier@3.6.2 --check .github/workflows/macos-pro-test-build.yml src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit workflow packaging**

```powershell
git add .github/workflows/macos-pro-test-build.yml
git commit -m "ci: bundle RawTherapee with macOS Pro packages"
```

### Task 4: Verify Locally And Rebuild On GitHub

**Files:**
- Verify: `.github/workflows/macos-pro-test-build.yml`
- Verify: `src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json`
- Verify: `tools/macos/README-FrameCull-Pro-macOS-first-launch.txt`

- [ ] **Step 1: Run local regression checks**

```powershell
pnpm test
pnpm run build:release:pro:macos
$env:ORT_SKIP_DOWNLOAD='1'
cargo check --manifest-path src-tauri\Cargo.toml --features pro-bench --bins
Remove-Item Env:ORT_SKIP_DOWNLOAD
```

Expected: 29 test files and 220 tests pass, the Pro release check passes, and
the Rust check exits zero.

- [ ] **Step 2: Push the feature branch**

```powershell
git push origin codex/pro-flash-0.1.6-update
```

Expected: the push starts a new `Build macOS Pro Test Packages` run.

- [ ] **Step 3: Monitor all three Actions jobs**

```powershell
$headSha = git rev-parse HEAD
$runs = gh run list --workflow macos-pro-test-build.yml --branch codex/pro-flash-0.1.6-update --limit 10 --json databaseId,headSha,status,conclusion,url | ConvertFrom-Json
$run = $runs | Where-Object headSha -eq $headSha | Select-Object -First 1
if (-not $run) { throw "No macOS Pro workflow run found for $headSha" }
$runId = [string]$run.databaseId
gh run watch $runId --exit-status --interval 15
```

Expected: `Build Pro macOS-arm64`, `Build Pro macOS-x64`, and
`Publish Pro draft release` all succeed.

- [ ] **Step 4: Inspect build logs for the pinned archive**

```powershell
gh run view $runId --log | Select-String -Pattern 'RawTherapee_macOS_15.4_Universal_5.12.zip|2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688'
```

Expected: both matrix jobs verify the same upstream artifact and digest.

### Task 5: Download And Verify The New Pro ZIPs

**Files:**
- Create: `C:/Users/29238/Desktop/FrameCull-Pro-macOS-Test-0.1.6-run-$runId/FrameCull-Pro-macOS-arm64.zip`
- Create: `C:/Users/29238/Desktop/FrameCull-Pro-macOS-Test-0.1.6-run-$runId/FrameCull-Pro-macOS-x64.zip`

- [ ] **Step 1: Download the new Draft Release assets**

```powershell
$tag = "macos-pro-test-0.1.6-run-$runId"
$dest = "C:\Users\29238\Desktop\FrameCull-Pro-macOS-Test-0.1.6-run-$runId"
New-Item -ItemType Directory -Path $dest | Out-Null
gh release download $tag --repo Ray25010/Frame-Cull-AI --dir $dest --pattern 'FrameCull-Pro-macOS-*.zip'
```

- [ ] **Step 2: Match local ZIPs to GitHub asset digests**

```powershell
$release = gh release view $tag --repo Ray25010/Frame-Cull-AI --json assets,isDraft,name | ConvertFrom-Json
foreach ($asset in $release.assets) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $dest $asset.name) -Algorithm SHA256).Hash.ToLowerInvariant()
  $expected = $asset.digest -replace '^sha256:', ''
  if ($actual -ne $expected) { throw "$($asset.name) release digest mismatch" }
}
```

Expected: both local ZIP digests match GitHub.

- [ ] **Step 3: Extract and verify each internal checksum**

For each architecture, extract the outer ZIP, parse every line in
`SHA256SUMS.txt`, and compare it with `Get-FileHash`. Require these files:

```text
FrameCull AI Pro_0.1.6_aarch64.dmg
FrameCull AI Pro_0.1.6_x64.dmg
RawTherapee_macOS_15.4_Universal_5.12.zip
FrameCull-Pro-First-Launch.command
README-FrameCull-Pro-macOS-first-launch.txt
SHA256SUMS.txt
```

Also require the included RawTherapee archive SHA-256 to equal:

```text
2F284D1C023F53F0C492AECC3F7635D6B7807EF22D5413EE55715D81E81FE688
```

- [ ] **Step 4: Reconfirm security and product boundaries**

Require ZIP entries and README text to contain `FrameCull AI Pro`, never
`FrameCull AI Flash`. Inspect the helper mode with `tar -tvf`; it must remain
executable. Inspect helper text; it must target only
`/Applications/FrameCull AI Pro.app` and must not contain `sudo` or
`spctl --master-disable`.

- [ ] **Step 5: Report final distribution paths and signing status**

Report both absolute desktop ZIP paths, outer SHA-256 values, internal checksum
results, Actions run URL, and Draft Release URL. State explicitly that
FrameCull remains ad-hoc signed and unnotarized, while RawTherapee is preserved
as the untouched official upstream installer archive.
