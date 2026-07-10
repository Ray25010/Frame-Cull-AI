# FrameCull AI Pro macOS 统一安装器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个可重复运行的 macOS 脚本完成 FrameCull AI Pro 首次安装和后续更新；RawTherapee/CLI 健康时只更新 FrameCull，缺失或验证失败时才修复 RawTherapee。

**Architecture:** 官方 RawTherapee ZIP 继续原样放在外层 Pro ZIP。统一脚本先验证包，再通过真实 CLI `-v` 选择 `UPDATE_FRAMECULL_ONLY` 或 `REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL`；FrameCull 后端增加与脚本安装位置一致的固定候选路径。GitHub Actions 只执行脚本单测和 `--verify-only`，绝不在 runner 上执行正常安装。

**Tech Stack:** Rust/Tauri 2、zsh、AppleScript、`hdiutil`、`plutil`、`ditto`、Node.js、GitHub Actions、Vitest、Cargo。

---

## 文件职责

- `src-tauri/src/lib.rs`：生成并使用 macOS RawTherapee CLI 固定候选路径；保留 Windows 行为。
- `tools/macos/FrameCull-Pro-Install.command`：统一验证、状态判断、挂载、授权安装、CLI 配置、清理和启动。
- `tools/macos/FrameCull-Pro-Install.test.zsh`：无安装副作用地测试健康判断和状态分支。
- `tools/macos/check-pro-installer-contract.mjs`：在 Windows 和 CI 上静态验证脚本、README、workflow 与安全边界。
- `tools/macos/README-FrameCull-Pro-macOS-first-launch.txt`：以一个脚本为主流程，保留拖入终端和手动安装回退。
- `.github/workflows/macos-pro-test-build.yml`：运行测试、staging、自检和双架构发布。
- 删除 `tools/macos/FrameCull-Pro-First-Launch.command`：不再保留第二个用户脚本。

### Task 1: 用 TDD 修正 macOS CLI 候选路径

**Files:**
- Modify: `src-tauri/src/lib.rs:3796`
- Test: `src-tauri/src/lib.rs:6662`

- [ ] **Step 1: 先写失败的纯函数测试**

在 tests 模块中加入：

```rust
#[test]
fn macos_rawtherapee_candidates_match_supported_priority_order() {
    let home = PathBuf::from("/Users/framecull-test");
    let candidates = macos_rawtherapee_candidates(Some(&home));

    assert_eq!(
        candidates,
        vec![
            (
                home.join("Library")
                    .join("Application Support")
                    .join("com.framecull.ai.pro")
                    .join("tools")
                    .join("rawtherapee-cli"),
                "SYSTEM",
            ),
            (PathBuf::from("/usr/local/bin/rawtherapee-cli"), "SYSTEM"),
            (PathBuf::from("/opt/homebrew/bin/rawtherapee-cli"), "SYSTEM"),
        ]
    );
}
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib tests::macos_rawtherapee_candidates_match_supported_priority_order -- --exact
```

Expected: FAIL，原因是 `macos_rawtherapee_candidates` 尚不存在。

- [ ] **Step 3: 实现最小候选生成函数**

在 `rawtherapee_candidates` 前加入：

```rust
#[cfg(any(test, all(feature = "pro", target_os = "macos")))]
fn macos_rawtherapee_candidates(
    home_dir: Option<&Path>,
) -> Vec<(PathBuf, &'static str)> {
    let mut candidates = Vec::new();
    if let Some(home_dir) = home_dir {
        candidates.push((
            home_dir
                .join("Library")
                .join("Application Support")
                .join("com.framecull.ai.pro")
                .join("tools")
                .join("rawtherapee-cli"),
            "SYSTEM",
        ));
    }
    candidates.push((PathBuf::from("/usr/local/bin/rawtherapee-cli"), "SYSTEM"));
    candidates.push((PathBuf::from("/opt/homebrew/bin/rawtherapee-cli"), "SYSTEM"));
    candidates
}
```

在 PATH 扫描之前插入 macOS 固定候选：

```rust
#[cfg(target_os = "macos")]
{
    let home_dir = std::env::var_os("HOME").map(PathBuf::from);
    candidates.extend(macos_rawtherapee_candidates(home_dir.as_deref()));
}
```

删除旧的：

```rust
PathBuf::from("/Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli")
```

Windows 专用分支和 PATH 扫描保持不变。

- [ ] **Step 4: 运行聚焦测试并确认 GREEN**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib tests::macos_rawtherapee_candidates_match_supported_priority_order -- --exact
```

Expected: 1 passed。

- [ ] **Step 5: 提交候选路径修正**

```powershell
git add src-tauri/src/lib.rs
git commit -m "fix: detect installed RawTherapee CLI on macOS"
```

### Task 2: 测试驱动实现可重复运行的统一安装脚本

**Files:**
- Create: `tools/macos/FrameCull-Pro-Install.command`
- Create: `tools/macos/FrameCull-Pro-Install.test.zsh`
- Create: `tools/macos/check-pro-installer-contract.mjs`
- Modify: `tools/macos/README-FrameCull-Pro-macOS-first-launch.txt`
- Delete: `tools/macos/FrameCull-Pro-First-Launch.command`

- [ ] **Step 1: 先创建跨平台契约检查器**

检查器接受 `--source` 或 `--workflow`，收集失败后一次性退出非零：

```javascript
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const mode = process.argv[2] ?? "--source";
const failures = [];
const read = path => readFileSync(resolve(root, path), "utf8");

if (mode === "--source") {
  const scriptPath = "tools/macos/FrameCull-Pro-Install.command";
  const readmePath = "tools/macos/README-FrameCull-Pro-macOS-first-launch.txt";
  if (!existsSync(resolve(root, scriptPath))) failures.push(`${scriptPath}: missing`);
  if (existsSync(resolve(root, scriptPath))) {
    const script = read(scriptPath);
    for (const required of [
      "VERIFY_ONLY",
      "UPDATE_FRAMECULL_ONLY",
      "REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL",
      "/Applications/FrameCull AI Pro.app",
      "/Applications/RawTherapee.app",
      "Application Support/com.framecull.ai.pro/tools/rawtherapee-cli",
      "2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688",
      "with administrator privileges",
      "--verify-only",
    ]) {
      if (!script.includes(required)) failures.push(`${scriptPath}: missing ${required}`);
    }
    for (const forbidden of [/\bsudo\b/, /spctl\s+--master-disable/, /\beval\b/]) {
      if (forbidden.test(script)) failures.push(`${scriptPath}: forbidden ${forbidden}`);
    }
  }
  const readme = read(readmePath);
  for (const required of ["FrameCull-Pro-Install.command", "/bin/zsh ", "后续更新", "只更新 FrameCull"]) {
    if (!readme.includes(required)) failures.push(`${readmePath}: missing ${required}`);
  }
  if (existsSync(resolve(root, "tools/macos/FrameCull-Pro-First-Launch.command"))) {
    failures.push("old Pro first-launch helper still exists");
  }
} else if (mode === "--workflow") {
  const workflowPath = ".github/workflows/macos-pro-test-build.yml";
  const workflow = read(workflowPath);
  for (const required of [
    "FrameCull-Pro-Install.command",
    "FrameCull-Pro-Install.test.zsh",
    "check-pro-installer-contract.mjs --workflow",
    "--verify-only",
  ]) {
    if (!workflow.includes(required)) failures.push(`${workflowPath}: missing ${required}`);
  }
  if (workflow.includes("FrameCull-Pro-First-Launch.command")) {
    failures.push(`${workflowPath}: old helper reference remains`);
  }
} else {
  failures.push(`unknown mode: ${mode}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`macOS Pro installer contract ${mode}: PASS`);
```

- [ ] **Step 2: 运行 source 契约并确认 RED**

```powershell
node tools/macos/check-pro-installer-contract.mjs --source
```

Expected: FAIL，至少报告统一脚本缺失、旧 helper 仍存在和 README 主流程缺失。

- [ ] **Step 3: 先写 zsh 状态测试**

`FrameCull-Pro-Install.test.zsh` 使用临时目录创建假的 app 和 CLI，以 `FRAMECULL_INSTALLER_SOURCE_ONLY=1` source 生产脚本，覆盖：

```text
app + managed CLI + valid -v       -> UPDATE_FRAMECULL_ONLY
app + /usr/local CLI + valid -v    -> UPDATE_FRAMECULL_ONLY
app + Homebrew CLI + valid -v      -> UPDATE_FRAMECULL_ONLY
app missing                         -> REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL
CLI missing                         -> REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL
CLI not executable                  -> REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL
CLI -v exits nonzero                -> REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL
CLI -v output lacks RawTherapee     -> REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL
```

再覆盖 `run_install_for_mode`：通过覆写 `install_frame_only` 和 `repair_rawtherapee_and_install_frame` 记录调用次数，断言更新路径只调用前者一次，RawTherapee 修复函数调用次数为零。

测试骨架使用与生产一致的函数签名：

```zsh
#!/bin/zsh
set -euo pipefail

readonly TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
export FRAMECULL_INSTALLER_SOURCE_ONLY=1
source "${TEST_DIR}/FrameCull-Pro-Install.command"

TEST_ROOT="$(mktemp -d)"
trap '/bin/rm -rf "${TEST_ROOT}"' EXIT

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  [[ "${actual}" == "${expected}" ]] || {
    print -u2 -r -- "${label}: expected ${expected}, got ${actual}"
    return 1
  }
}

make_cli() {
  local path="$1"
  local behavior="$2"
  /bin/mkdir -p "$(dirname "${path}")"
  case "${behavior}" in
    valid)
      /usr/bin/printf '%s\n' '#!/bin/zsh' 'print -r -- "RawTherapee, version 5.12-test"' > "${path}"
      ;;
    invalid)
      /usr/bin/printf '%s\n' '#!/bin/zsh' 'exit 3' > "${path}"
      ;;
    wrong-output)
      /usr/bin/printf '%s\n' '#!/bin/zsh' 'print -r -- "not the expected engine"' > "${path}"
      ;;
  esac
  /bin/chmod 755 "${path}"
}

raw_app="${TEST_ROOT}/Applications/RawTherapee.app"
managed_cli="${TEST_ROOT}/managed/rawtherapee-cli"
local_cli="${TEST_ROOT}/usr-local/rawtherapee-cli"
brew_cli="${TEST_ROOT}/homebrew/rawtherapee-cli"
/bin/mkdir -p "${raw_app}"
make_cli "${managed_cli}" valid

mode="$(determine_install_mode "${raw_app}" "${managed_cli}" "${local_cli}" "${brew_cli}")"
assert_equal "${MODE_UPDATE}" "${mode}" "healthy managed CLI"

/bin/rm -f "${managed_cli}"
make_cli "${local_cli}" valid
mode="$(determine_install_mode "${raw_app}" "${managed_cli}" "${local_cli}" "${brew_cli}")"
assert_equal "${MODE_UPDATE}" "${mode}" "healthy /usr/local-style CLI"

/bin/rm -rf "${raw_app}"
mode="$(determine_install_mode "${raw_app}" "${managed_cli}" "${local_cli}" "${brew_cli}")"
assert_equal "${MODE_REPAIR}" "${mode}" "missing RawTherapee app"

/bin/mkdir -p "${raw_app}"
/bin/rm -f "${local_cli}"
make_cli "${managed_cli}" invalid
mode="$(determine_install_mode "${raw_app}" "${managed_cli}" "${local_cli}" "${brew_cli}")"
assert_equal "${MODE_REPAIR}" "${mode}" "invalid CLI"

frame_calls=0
repair_calls=0
install_frame_only() { frame_calls=$((frame_calls + 1)); }
repair_rawtherapee_and_install_frame() { repair_calls=$((repair_calls + 1)); }
run_install_for_mode "${MODE_UPDATE}"
assert_equal "1" "${frame_calls}" "FrameCull update call count"
assert_equal "0" "${repair_calls}" "RawTherapee repair call count"

print -r -- "FrameCull Pro installer state tests: PASS"
```

- [ ] **Step 4: 在 macOS 上确认状态测试当前为 RED**

```bash
/bin/zsh tools/macos/FrameCull-Pro-Install.test.zsh
```

Expected: FAIL，因为生产脚本尚不存在。在 Windows 开发机上记录此项由后续 Actions macOS runner 执行。

- [ ] **Step 5: 实现统一脚本的固定接口与状态机**

脚本必须使用：

```zsh
#!/bin/zsh
set -euo pipefail

readonly MODE_VERIFY_ONLY="VERIFY_ONLY"
readonly MODE_UPDATE="UPDATE_FRAMECULL_ONLY"
readonly MODE_REPAIR="REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL"
readonly FRAME_APP="/Applications/FrameCull AI Pro.app"
readonly RAW_APP="/Applications/RawTherapee.app"
readonly RAW_ARCHIVE_NAME="RawTherapee_macOS_15.4_Universal_5.12.zip"
readonly RAW_ARCHIVE_SHA256="2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688"
readonly MANAGED_CLI="${HOME}/Library/Application Support/com.framecull.ai.pro/tools/rawtherapee-cli"
typeset -a MOUNTED_DEVICES
WORK_DIR=""
```

实现并由 `main` 调用以下边界：

```text
verify_package_contract
run_cli_version_with_timeout <cli> <seconds>
find_healthy_rawtherapee_cli <app> <candidate...>
determine_install_mode
extract_rawtherapee_payload
attach_dmg_readonly <dmg>
install_frame_only_privileged <frame-source-app>
install_frame_and_raw_privileged <frame-source-app> <raw-source-app>
install_cli_for_user <source-cli>
run_install_for_mode <mode>
cleanup
```

关键行为必须是：

```zsh
determine_install_mode() {
  local raw_app="$1"
  shift
  if find_healthy_rawtherapee_cli "${raw_app}" "$@" >/dev/null; then
    print -r -- "${MODE_UPDATE}"
  else
    print -r -- "${MODE_REPAIR}"
  fi
}

run_install_for_mode() {
  local mode="$1"
  case "${mode}" in
    "${MODE_UPDATE}") install_frame_only ;;
    "${MODE_REPAIR}") repair_rawtherapee_and_install_frame ;;
    *) print -u2 -r -- "Unknown installer mode: ${mode}"; return 1 ;;
  esac
}
```

正常模式用固定路径调用：

```zsh
mode="$(determine_install_mode \
  "${RAW_APP}" \
  "${MANAGED_CLI}" \
  "/usr/local/bin/rawtherapee-cli" \
  "/opt/homebrew/bin/rawtherapee-cli")"
run_install_for_mode "${mode}"
```

文件末尾必须保留 source-only 测试门：

```zsh
if [[ "${FRAMECULL_INSTALLER_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
```

`UPDATE_FRAMECULL_ONLY` 不得调用 RawTherapee 解压、挂载、复制或 xattr 函数。`VERIFY_ONLY` 只校验 checksum 和官方 ZIP 固定结构后退出。

- [ ] **Step 6: 用结构化系统工具实现挂载与一次授权**

`attach_dmg_readonly` 使用：

```zsh
/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -plist "${dmg}" > "${plist}"
```

循环 `system-entities.0` 至 `system-entities.15`，分别用：

```zsh
/usr/bin/plutil -extract "system-entities.${index}.mount-point" raw -o - "${plist}"
/usr/bin/plutil -extract "system-entities.${index}.dev-entry" raw -o - "${plist}"
```

要求恰好一个 mount point，把对应 `/dev/disk*` 放入 `MOUNTED_DEVICES`。`cleanup` 按反向顺序 detach，仅清理本次记录的设备和 `WORK_DIR`。

两个提权函数必须分开，保证更新路径的 AppleScript 命令中完全没有 RawTherapee 目标。使用 `osascript` 的 `on run argv` 传入来源 app，AppleScript 用 `quoted form of` 生成命令；固定目标写死。命令只允许 `/bin/rm -rf` 精确同名目标、`/usr/bin/ditto` 和 `/usr/bin/xattr -dr com.apple.quarantine`。禁止 `sudo`、`eval` 和全局 Gatekeeper 命令。

- [ ] **Step 7: 实现原子 CLI 安装和最终验证**

修复路径先安装两个 app，再把 CLI 复制到用户目录临时文件，`chmod 755`、只移除该文件 quarantine，最后 `mv` 到 `MANAGED_CLI`。随后要求：

```zsh
/usr/bin/codesign --verify --deep --strict "${FRAME_APP}"
run_cli_version_with_timeout "${healthy_cli}" 10
/usr/bin/open "${FRAME_APP}"
```

更新路径复用状态判断找到的健康 CLI；修复路径必须重新验证 `MANAGED_CLI`。管理员取消、签名失败或 CLI 验证失败时不得启动 FrameCull。

- [ ] **Step 8: 更新 README 并删除旧 helper**

README 主流程改为：解压 ZIP，右键打开 `FrameCull-Pro-Install.command`，需要时确认一次系统密码。明确：

- 首次安装或 RawTherapee/CLI 损坏时安装两个 app 和 CLI。
- 后续健康更新只替换 FrameCull AI Pro，不重新安装 RawTherapee。
- Finder 拦截时，在终端输入 `/bin/zsh `，拖入脚本并回车。
- FrameCull 仍为 ad-hoc 签名、未公证。
- 保留手动打开 DMG/复制 CLI 的故障回退，不作为主流程。

删除 `tools/macos/FrameCull-Pro-First-Launch.command`。

- [ ] **Step 9: 运行 source 契约并确认 GREEN**

```powershell
node tools/macos/check-pro-installer-contract.mjs --source
git diff --check
```

Expected: PASS；工作区只包含本 Task 指定文件。

- [ ] **Step 10: 提交统一脚本与文档**

```powershell
git add tools/macos/FrameCull-Pro-Install.command tools/macos/FrameCull-Pro-Install.test.zsh tools/macos/check-pro-installer-contract.mjs tools/macos/README-FrameCull-Pro-macOS-first-launch.txt tools/macos/FrameCull-Pro-First-Launch.command
git commit -m "feat: add unified macOS Pro installer"
```

### Task 3: 把统一安装器接入双架构 Pro workflow

**Files:**
- Modify: `.github/workflows/macos-pro-test-build.yml`

- [ ] **Step 1: 先运行 workflow 契约并确认 RED**

```powershell
node tools/macos/check-pro-installer-contract.mjs --workflow
```

Expected: FAIL，报告 workflow 仍引用旧 helper，且缺少脚本单测和 `--verify-only`。

- [ ] **Step 2: 更新触发路径和输入验证**

把旧 helper path 替换为：

```yaml
- "tools/macos/FrameCull-Pro-Install.command"
- "tools/macos/FrameCull-Pro-Install.test.zsh"
- "tools/macos/check-pro-installer-contract.mjs"
```

`Validate Pro package inputs` 改为：

```bash
/bin/zsh -n tools/macos/FrameCull-Pro-Install.command
/bin/zsh -n tools/macos/FrameCull-Pro-Install.test.zsh
node tools/macos/check-pro-installer-contract.mjs --source
```

- [ ] **Step 3: 只在一个 matrix job 运行聚焦测试**

在 arm64 matrix 项上运行：

```yaml
- name: Test unified Pro installer state machine
  if: matrix.rust_target == 'aarch64-apple-darwin'
  shell: bash
  run: |
    set -euo pipefail
    /bin/zsh tools/macos/FrameCull-Pro-Install.test.zsh
    cargo test --manifest-path src-tauri/Cargo.toml --lib tests::macos_rawtherapee_candidates_match_supported_priority_order -- --exact
```

该步骤不得使用安装器正常模式，也不得写 `/Applications`。

- [ ] **Step 4: staging 只放一个脚本并生成校验清单**

替换 copy/chmod/checksum 命令：

```bash
cp tools/macos/FrameCull-Pro-Install.command "${stage_dir}/"
cp tools/macos/README-FrameCull-Pro-macOS-first-launch.txt "${stage_dir}/"
chmod +x "${stage_dir}/FrameCull-Pro-Install.command"

(
  cd "${stage_dir}"
  /usr/bin/shasum -a 256 ./*.dmg "${RAWTHERAPEE_ARTIFACT}" FrameCull-Pro-Install.command README-FrameCull-Pro-macOS-first-launch.txt > SHA256SUMS.txt
  /bin/zsh ./FrameCull-Pro-Install.command --verify-only
)
```

再复制 stage 到临时负向目录，追加一行到 README，要求 `--verify-only` 返回非零；负向测试不能修改正式 stage。

- [ ] **Step 5: 更新 Draft Release notes**

说明每个 Pro ZIP：

- 包含一个统一安装/更新脚本。
- RawTherapee 健康时只更新 FrameCull。
- RawTherapee 缺失或验证失败时才修复。
- 官方 RawTherapee ZIP 保持原样并受 checksum 覆盖。
- FrameCull 为 ad-hoc、未公证测试版。

- [ ] **Step 6: 运行 workflow 契约和格式检查**

```powershell
node tools/macos/check-pro-installer-contract.mjs --workflow
pnpm dlx prettier@3.6.2 --check .github/workflows/macos-pro-test-build.yml src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json
git diff --check
```

Expected: PASS。

- [ ] **Step 7: 提交 workflow**

```powershell
git add .github/workflows/macos-pro-test-build.yml
git commit -m "ci: verify unified macOS Pro installer"
```

### Task 4: 本地回归、双重审查和推送

**Files:**
- Verify all modified files.

- [ ] **Step 1: 运行完整本地门禁**

```powershell
node tools/macos/check-pro-installer-contract.mjs --source
node tools/macos/check-pro-installer-contract.mjs --workflow
cargo test --manifest-path src-tauri\Cargo.toml --lib tests::macos_rawtherapee_candidates_match_supported_priority_order -- --exact
pnpm test
pnpm run build:release:pro:macos
$env:ORT_SKIP_DOWNLOAD='1'
cargo check --manifest-path src-tauri\Cargo.toml --features pro-bench --bins
Remove-Item Env:ORT_SKIP_DOWNLOAD
pnpm dlx prettier@3.6.2 --check .github/workflows/macos-pro-test-build.yml src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json
git diff --check
```

Expected: 聚焦 Rust 测试通过；29 个测试文件、220 项前端测试通过；Pro release、Rust check、格式和契约全部通过。

- [ ] **Step 2: 逐 Task 做规格审查和质量审查**

按 subagent-driven 流程，每个实现提交先做规格审查，再做代码质量审查；发现问题由原实现代理修复并复审。重点检查：

- 更新路径不能引用 RawTherapee 安装函数。
- AppleScript 动态参数全部安全引用。
- `--verify-only` 无挂载、无授权、无安装、无启动。
- Flash、Windows RawTherapee、x64 ONNX Runtime 不变。

- [ ] **Step 3: 推送 feature branch**

```powershell
git push origin codex/pro-flash-0.1.6-update
```

### Task 5: 远程构建和替代发布包验收

**Files:**
- Create: `C:/Users/29238/Desktop/FrameCull-Pro-macOS-Test-0.1.6-run-$runId/FrameCull-Pro-macOS-arm64.zip`
- Create: `C:/Users/29238/Desktop/FrameCull-Pro-macOS-Test-0.1.6-run-$runId/FrameCull-Pro-macOS-x64.zip`

- [ ] **Step 1: 监控三个 Actions jobs**

定位 HEAD 对应 run，并运行：

```powershell
gh run watch $runId --repo Ray25010/Frame-Cull-AI --exit-status --interval 15
```

Expected: arm64、x64 和 Draft Release 全部 success；日志中统一脚本单测、Rust 聚焦测试、两次 staged `--verify-only` 和负向篡改测试通过。

- [ ] **Step 2: 下载新 Draft Release 两个 ZIP**

下载到新的 run 目录。网络中断时使用 GitHub asset API、`curl --continue-at - --retry-all-errors` 续传，不接受部分文件。

- [ ] **Step 3: 验证外层与内部契约**

逐架构要求：

```text
FrameCull AI Pro_0.1.6_<arch>.dmg
RawTherapee_macOS_15.4_Universal_5.12.zip
FrameCull-Pro-Install.command
README-FrameCull-Pro-macOS-first-launch.txt
SHA256SUMS.txt
```

并验证：

- 外层 ZIP SHA 与 GitHub asset digest 一致。
- `SHA256SUMS.txt` 四个 payload 全部匹配。
- RawTherapee SHA 固定为 `2f284d1c...fe688`。
- 官方 ZIP 内实际包含 DMG、独立 CLI 和 `install-readme.txt`。
- 统一脚本 Unix mode 可执行、LF 换行、无旧 helper、无 `sudo`、无 `eval`、无全局 Gatekeeper 命令。
- README 包含右键打开和 `/bin/zsh ` 拖入终端回退。
- 包和 runner 验证均为 FrameCull AI Pro，不含 Flash 身份。

- [ ] **Step 4: 报告动态验证边界**

报告新 ZIP 绝对路径、SHA、Actions 与 Draft Release URL。明确说明：Actions 已验证构建、签名、状态机单测和 `--verify-only`；正常安装和真实“首次安装/后续更新”仍需 Mac 测试用户各执行一次，不能把 runner 自检表述成真实安装证明。
