#!/bin/zsh
set -euo pipefail

APP_TITLE="FrameCull AI Flash Mac Builder"
BUILD_STAMP="$(date +%Y%m%d-%H%M%S)"
WORK_ROOT=""
RUN_OUT=""
LOG_FILE=""

show_dialog() {
  local title="$1"
  local message="$2"
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'display dialog (item 2 of argv) buttons {"OK"} default button "OK" with title (item 1 of argv)' \
    -e 'end run' \
    "$title" "$message" >/dev/null
}

confirm_dialog() {
  local title="$1"
  local message="$2"
  local result
  result="$(/usr/bin/osascript \
    -e 'on run argv' \
    -e 'set dialogResult to display dialog (item 2 of argv) buttons {"取消", "继续"} default button "继续" cancel button "取消" with title (item 1 of argv)' \
    -e 'return button returned of dialogResult' \
    -e 'end run' \
    "$title" "$message" 2>/dev/null || true)"
  [[ "$result" == "继续" ]]
}

choose_from_list() {
  local prompt="$1"
  shift
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'set itemList to items 2 thru -1 of argv' \
    -e 'set picked to choose from list itemList with prompt (item 1 of argv) default items {item 2 of argv} without multiple selections allowed' \
    -e 'if picked is false then error number -128' \
    -e 'return item 1 of picked' \
    -e 'end run' \
    "$prompt" "$@"
}

refresh_shell_paths() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
  fi
}

ensure_xcode_command_line_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    echo "Xcode Command Line Tools: ready"
    return
  fi

  echo "Xcode Command Line Tools are missing."
  if confirm_dialog "$APP_TITLE" "缺少 Xcode Command Line Tools。macOS 构建必须依赖它。\n\n现在打开系统安装器吗？安装完成后需要重新运行本工具。"; then
    xcode-select --install || true
    show_dialog "$APP_TITLE" "已经打开 Xcode Command Line Tools 安装器。\n\n请完成安装后重新运行本工具。"
    exit 0
  fi
  echo "Xcode Command Line Tools installation was cancelled."
  return 1
}

ensure_homebrew() {
  refresh_shell_paths
  if command -v brew >/dev/null 2>&1; then
    echo "Homebrew: $(brew --version | head -n 1)"
    return
  fi

  echo "Homebrew is missing."
  if ! confirm_dialog "$APP_TITLE" "缺少 Homebrew。需要它来现场安装 Node.js 等构建依赖。\n\n现在安装 Homebrew 吗？过程中可能需要输入 Mac 登录密码。"; then
    echo "Homebrew installation was cancelled."
    return 1
  fi

  echo "Installing Homebrew..."
  /bin/bash -c "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  refresh_shell_paths

  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew installation finished, but brew is still not on PATH."
    echo "Open a new Terminal once, then run this builder again."
    return 1
  fi
}

ensure_node() {
  refresh_shell_paths
  if command -v node >/dev/null 2>&1; then
    echo "Node.js: $(node --version)"
    return
  fi

  echo "Node.js is missing."
  if ! confirm_dialog "$APP_TITLE" "缺少 Node.js。前端构建和 pnpm 安装都需要它。\n\n现在通过 Homebrew 安装 Node.js 吗？"; then
    echo "Node.js installation was cancelled."
    return 1
  fi

  ensure_homebrew
  brew install node
  refresh_shell_paths
  node --version
}

ensure_pnpm() {
  refresh_shell_paths
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm: $(pnpm --version)"
    return
  fi

  ensure_node
  echo "pnpm is missing. Installing pnpm..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@latest --activate
  else
    npm install -g pnpm
  fi
  refresh_shell_paths
  pnpm --version
}

ensure_rust() {
  refresh_shell_paths
  if command -v cargo >/dev/null 2>&1 && command -v rustup >/dev/null 2>&1; then
    echo "cargo: $(cargo --version)"
    echo "rustup: $(rustup --version | head -n 1)"
    return
  fi

  echo "Rust toolchain is missing or incomplete."
  if ! confirm_dialog "$APP_TITLE" "缺少 Rust / cargo / rustup。Tauri 打包必须依赖它。\n\n现在安装 Rust stable toolchain 吗？"; then
    echo "Rust installation was cancelled."
    return 1
  fi

  /usr/bin/curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  refresh_shell_paths
  rustup default stable
  cargo --version
}

ensure_system_dependencies() {
  refresh_shell_paths
  ensure_xcode_command_line_tools
  ensure_node
  ensure_pnpm
  ensure_rust
}

choose_source() {
  local mode
  mode="$(choose_from_list "请选择源码类型" "源码文件夹" "源码压缩包 zip/tar/tgz")"
  if [[ "$mode" == "源码文件夹" ]]; then
    /usr/bin/osascript -e 'POSIX path of (choose folder with prompt "选择 FrameCull AI 源码文件夹")'
  else
    /usr/bin/osascript -e 'POSIX path of (choose file with prompt "选择 FrameCull AI 源码压缩包（zip、tar、tar.gz、tgz）")'
  fi
}

choose_output_dir() {
  /usr/bin/osascript -e 'POSIX path of (choose folder with prompt "选择 macOS 构建产物输出目录")'
}

on_error() {
  local status=$?
  local message="构建失败。"
  if [[ -n "${LOG_FILE:-}" ]]; then
    message="${message}\n\n日志：${LOG_FILE}"
  fi
  if [[ -n "${WORK_ROOT:-}" && -d "$WORK_ROOT" ]]; then
    message="${message}\n\n临时构建目录已保留：${WORK_ROOT}"
  fi
  show_dialog "$APP_TITLE" "$message"
  exit "$status"
}
trap on_error ERR

copy_or_unpack_source() {
  local source_path="$1"
  local build_dir="$2"
  mkdir -p "$build_dir"

  if [[ -d "$source_path" ]]; then
    echo "Copying source folder..."
    /usr/bin/rsync -a \
      --exclude ".git" \
      --exclude ".DS_Store" \
      --exclude "node_modules" \
      --exclude "dist" \
      --exclude "dist-ssr" \
      --exclude "src-tauri/target" \
      --exclude "src-tauri/vendor/rawtherapee/downloads" \
      "$source_path/" "$build_dir/"
    return
  fi

  local lower="${source_path:l}"
  echo "Unpacking source archive..."
  case "$lower" in
    *.zip)
      /usr/bin/ditto -x -k "$source_path" "$build_dir"
      ;;
    *.tar.gz|*.tgz)
      /usr/bin/tar -xzf "$source_path" -C "$build_dir"
      ;;
    *.tar)
      /usr/bin/tar -xf "$source_path" -C "$build_dir"
      ;;
    *)
      echo "Unsupported source package: $source_path"
      echo "Please choose a folder, .zip, .tar, .tar.gz, or .tgz package."
      return 1
      ;;
  esac
}

find_project_root() {
  local build_dir="$1"
  if [[ -f "$build_dir/package.json" && -f "$build_dir/src-tauri/tauri.conf.json" ]]; then
    echo "$build_dir"
    return
  fi

  local found
  found="$(/usr/bin/find "$build_dir" -maxdepth 3 -type f -name package.json -print | while read -r package_json; do
    local dir
    dir="$(dirname "$package_json")"
    if [[ -f "$dir/src-tauri/tauri.conf.json" ]]; then
      echo "$dir"
      break
    fi
  done)"

  if [[ -z "$found" ]]; then
    echo "Could not find a Tauri project root in the selected source." >&2
    return 1
  fi
  echo "$found"
}

clean_heavy_build_dirs() {
  local project_root="$1"
  rm -rf "$project_root/node_modules" "$project_root/dist" "$project_root/dist-ssr" "$project_root/src-tauri/target"
  rm -rf "$project_root/src-tauri/vendor/rawtherapee/downloads"
}

copy_artifacts() {
  local project_root="$1"
  local out_dir="$2"
  local target_root="$project_root/src-tauri/target"
  local count=0

  mkdir -p "$out_dir"
  while IFS= read -r artifact; do
    count=$((count + 1))
    echo "Copying artifact: $artifact"
    if [[ -d "$artifact" ]]; then
      /usr/bin/ditto "$artifact" "$out_dir/$(basename "$artifact")"
    else
      /bin/cp -p "$artifact" "$out_dir/"
    fi
  done < <(/usr/bin/find "$target_root" \( -type d -name "*.app" -prune -print \) -o \( -type f -name "*.dmg" -print \))

  if [[ "$count" -eq 0 ]]; then
    echo "No .app or .dmg artifacts were found under $target_root"
    return 1
  fi
}

main() {
  local source_path output_parent target_choice test_choice rust_target project_root
  local -a target_args

  source_path="$(choose_source)"
  output_parent="$(choose_output_dir)"
  target_choice="$(choose_from_list "选择构建架构" "当前 Mac 架构（推荐）" "Apple Silicon arm64" "Intel x64")"
  test_choice="$(choose_from_list "是否运行测试" "跳过测试（更快，推荐）" "运行测试（更稳）")"

  RUN_OUT="$output_parent/FrameCull-AI-Flash-macOS-$BUILD_STAMP"
  mkdir -p "$RUN_OUT"
  LOG_FILE="$RUN_OUT/build.log"
  exec > >(tee -a "$LOG_FILE") 2>&1

  echo "=== $APP_TITLE ==="
  echo "Started at: $(date)"
  echo "Source: $source_path"
  echo "Output: $RUN_OUT"
  echo "Target: $target_choice"
  echo "Tests: $test_choice"

  ensure_system_dependencies

  case "$target_choice" in
    "Apple Silicon arm64")
      rust_target="aarch64-apple-darwin"
      ;;
    "Intel x64")
      rust_target="x86_64-apple-darwin"
      ;;
    *)
      rust_target=""
      ;;
  esac

  if [[ -n "$rust_target" ]]; then
    echo "Installing Rust target: $rust_target"
    rustup target add "$rust_target"
    target_args=(--target "$rust_target")
  else
    target_args=()
  fi

  WORK_ROOT="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/framecull-flash-build.XXXXXX")"
  copy_or_unpack_source "$source_path" "$WORK_ROOT/source"
  project_root="$(find_project_root "$WORK_ROOT/source")"
  clean_heavy_build_dirs "$project_root"

  echo "Project root: $project_root"
  cd "$project_root"

  echo "Installing dependencies..."
  if ! pnpm install --frozen-lockfile; then
    echo "Frozen install failed. Retrying with pnpm install in the temporary workspace..."
    pnpm install
  fi

  echo "Type checking..."
  pnpm exec tsc --noEmit

  if [[ "$test_choice" == "运行测试（更稳）" ]]; then
    echo "Running tests..."
    pnpm test
  fi

  echo "Building FrameCull AI Flash macOS DMG..."
  pnpm exec tauri build --config src-tauri/tauri.flash.conf.json --bundles dmg "${target_args[@]}"

  copy_artifacts "$project_root" "$RUN_OUT"

  echo "Finished at: $(date)"
  echo "Artifacts copied to: $RUN_OUT"
  rm -rf "$WORK_ROOT"
  WORK_ROOT=""

  show_dialog "$APP_TITLE" "构建完成。\n\n输出目录：${RUN_OUT}"
  /usr/bin/open "$RUN_OUT"
}

main
