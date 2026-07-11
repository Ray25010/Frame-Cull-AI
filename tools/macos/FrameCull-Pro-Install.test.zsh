#!/bin/zsh
set -euo pipefail

readonly TEST_DIR="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
export FRAMECULL_INSTALLER_SOURCE_ONLY=1
source "${TEST_DIR}/FrameCull-Pro-Install.command"
typeset -r PRODUCTION_INSTALL_FRAME_ONLY="${functions[install_frame_only]}"
typeset -r PRODUCTION_INSTALL_FRAME_ONLY_PRIVILEGED="${functions[install_frame_only_privileged]}"
typeset -r PRODUCTION_INSTALL_FRAME_AND_RAW_PRIVILEGED="${functions[install_frame_and_raw_privileged]}"
typeset -r PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION="${functions[build_frame_only_transaction_shell]}"
typeset -r PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION="${functions[build_frame_and_raw_transaction_shell]}"
typeset -r PRODUCTION_MAIN="${functions[main]}"
typeset -r PRODUCTION_ATTACH_DMG_READONLY="${functions[attach_dmg_readonly]}"
typeset -r PRODUCTION_RUN_CLI_VERSION_WITH_TIMEOUT="${functions[run_cli_version_with_timeout]}"
typeset -r PRODUCTION_CLEANUP="${functions[cleanup]}"
typeset -r PRODUCTION_TERMINATE_ACTIVE_CLI="${functions[terminate_active_cli]}"

TEST_ROOT="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf -- "${TEST_ROOT}"' EXIT

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    print -u2 -r -- "${label}: expected ${expected}, got ${actual}"
    return 1
  fi
}

assert_false() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    print -u2 -r -- "${label}: expected command to fail"
    return 1
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    print -u2 -r -- "${label}: expected to contain ${needle}"
    return 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    print -u2 -r -- "${label}: must not contain ${needle}"
    return 1
  fi
}

assert_order() {
  local haystack="$1"
  local before="$2"
  local after="$3"
  local label="$4"
  local prefix

  if [[ "${haystack}" != *"${before}"* || "${haystack}" != *"${after}"* ]]; then
    print -u2 -r -- "${label}: missing order markers"
    return 1
  fi
  prefix="${haystack%%"${after}"*}"
  if [[ "${prefix}" != *"${before}"* ]]; then
    print -u2 -r -- "${label}: expected ${before} before ${after}"
    return 1
  fi
}

assert_path_exists() {
  local path="$1"
  local label="$2"
  if [[ ! -e "${path}" && ! -L "${path}" ]]; then
    print -u2 -r -- "${label}: missing ${path}"
    return 1
  fi
}

assert_path_missing() {
  local path="$1"
  local label="$2"
  if [[ -e "${path}" || -L "${path}" ]]; then
    print -u2 -r -- "${label}: expected missing ${path}"
    return 1
  fi
}

assert_process_stopped() {
  local label="$1"
  local process_id="$2"
  if /bin/kill -0 "${process_id}" >/dev/null 2>&1; then
    /bin/kill -KILL "${process_id}" >/dev/null 2>&1 || :
    print -u2 -r -- "${label}: process ${process_id} survived"
    return 1
  fi
}

make_cli() {
  local path="$1"
  local behavior="$2"
  /bin/mkdir -p "$(/usr/bin/dirname "${path}")"

  case "${behavior}" in
    valid)
      /usr/bin/printf '%s\n' \
        '#!/bin/zsh' \
        'print -r -- "RawTherapee, version 5.12-test"' > "${path}"
      ;;
    nonzero)
      /usr/bin/printf '%s\n' \
        '#!/bin/zsh' \
        'exit 3' > "${path}"
      ;;
    wrong-output)
      /usr/bin/printf '%s\n' \
        '#!/bin/zsh' \
        'print -r -- "not the expected engine"' > "${path}"
      ;;
    misleading-output)
      /usr/bin/printf '%s\n' \
        '#!/bin/zsh' \
        'print -r -- "RawTherapee failed to initialize its version service"' > "${path}"
      ;;
    *)
      print -u2 -r -- "unknown fake CLI behavior: ${behavior}"
      return 1
      ;;
  esac

  /bin/chmod 755 "${path}"
}

make_fake_app_dir() {
  local path="$1"
  local marker="$2"
  /bin/mkdir -p "${path}/Contents"
  /usr/bin/printf '%s\n' "${marker}" > "${path}/Contents/marker.txt"
}

assert_app_marker() {
  local path="$1"
  local expected="$2"
  local label="$3"
  local marker_path="${path}/Contents/marker.txt"
  [[ -f "${marker_path}" ]] || {
    print -u2 -r -- "${label}: missing marker ${marker_path}"
    return 1
  }
  assert_equal "${expected}" "$(<"${marker_path}")" "${label}"
}

make_transaction_test_bins() {
  local bin_dir="$1"
  /bin/mkdir -p "${bin_dir}"
  /usr/bin/printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'src=$1' \
    'dst=$2' \
    'if [ -d "$src" ]; then' \
    '  mkdir -p "$dst"' \
    '  cp -R "$src"/. "$dst"/' \
    'else' \
    '  cp "$src" "$dst"' \
    'fi' > "${bin_dir}/fake-ditto"
  /usr/bin/printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'case "$1" in' \
    '  -p) exit 1 ;;' \
    '  -dr|-d) exit 0 ;;' \
    '  *) exit 0 ;;' \
    'esac' > "${bin_dir}/fake-xattr"
  /bin/chmod 755 "${bin_dir}/fake-ditto" "${bin_dir}/fake-xattr"
}

prepare_transaction_shell_for_test() {
  local shell_script="$1"
  local bin_dir="$2"

  shell_script="$(
    /usr/bin/printf '%s' "${shell_script}" |
      /usr/bin/sed \
        -e "s|/usr/bin/ditto|${bin_dir}/fake-ditto|g" \
        -e "s|/usr/bin/xattr|${bin_dir}/fake-xattr|g"
  )"
  /usr/bin/printf '%s' "${shell_script}"
}

inject_term_after_line() {
  local shell_script="$1"
  local needle="$2"
  local label="$3"
  local replacement

  assert_contains "${shell_script}" "${needle}" "${label}"
  replacement="${needle}"$'\n''/bin/kill -TERM $$'
  /usr/bin/printf '%s' "${shell_script/${needle}/${replacement}}"
}

run_transaction_shell() {
  local shell_script="$1"
  shift
  /bin/sh -c "${shell_script}" sh "$@"
}

assert_no_transaction_leaks() {
  local apps_dir="$1"
  local label="$2"
  typeset -a leftovers
  leftovers=("${apps_dir}"/.FrameCullAIPro-install.*(N) "${apps_dir}"/.FrameCullAIPro-backup.*(N))
  assert_equal "0" "${#leftovers[@]}" "${label}"
}

reset_fixture() {
  /bin/rm -rf -- "${TEST_ROOT}/case"
  /bin/mkdir -p "${TEST_ROOT}/case"
}

assert_fixture_mode() {
  local expected="$1"
  local label="$2"
  local raw_app="${TEST_ROOT}/case/Applications/RawTherapee.app"
  local managed_cli="${TEST_ROOT}/case/managed/rawtherapee-cli"
  local local_cli="${TEST_ROOT}/case/usr-local/rawtherapee-cli"
  local brew_cli="${TEST_ROOT}/case/homebrew/rawtherapee-cli"

  HEALTHY_RAW_CLI=""
  INSTALL_MODE=""
  if ! determine_install_mode \
    "${raw_app}" \
    "${managed_cli}" \
    "${local_cli}" \
    "${brew_cli}" >/dev/null; then
    print -u2 -r -- "${label}: determine_install_mode unexpectedly failed"
    return 1
  fi
  assert_equal "${expected}" "${INSTALL_MODE}" "${label}"
}

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
make_cli "${TEST_ROOT}/case/managed/rawtherapee-cli" valid
assert_fixture_mode "${MODE_UPDATE}" "healthy managed CLI"

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
make_cli "${TEST_ROOT}/case/usr-local/rawtherapee-cli" valid
assert_fixture_mode "${MODE_UPDATE}" "healthy /usr/local-style CLI"

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
make_cli "${TEST_ROOT}/case/homebrew/rawtherapee-cli" valid
assert_fixture_mode "${MODE_UPDATE}" "healthy Homebrew-style CLI"

reset_fixture
make_cli "${TEST_ROOT}/case/managed/rawtherapee-cli" valid
assert_fixture_mode "${MODE_REPAIR}" "missing RawTherapee app"

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
assert_fixture_mode "${MODE_REPAIR}" "missing CLI"

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
make_cli "${TEST_ROOT}/case/managed/rawtherapee-cli" valid
/bin/chmod 644 "${TEST_ROOT}/case/managed/rawtherapee-cli"
assert_fixture_mode "${MODE_REPAIR}" "non-executable CLI"

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
make_cli "${TEST_ROOT}/case/managed/rawtherapee-cli" nonzero
assert_fixture_mode "${MODE_REPAIR}" "CLI version exits nonzero"

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
make_cli "${TEST_ROOT}/case/managed/rawtherapee-cli" wrong-output
assert_fixture_mode "${MODE_REPAIR}" "CLI version output lacks RawTherapee"

reset_fixture
/bin/mkdir -p "${TEST_ROOT}/case/Applications/RawTherapee.app"
make_cli "${TEST_ROOT}/case/managed/rawtherapee-cli" misleading-output
assert_fixture_mode "${MODE_REPAIR}" "CLI exit zero with misleading RawTherapee error text"

functions[run_cli_version_with_timeout]="${PRODUCTION_RUN_CLI_VERSION_WITH_TIMEOUT}"
reset_fixture
stale_guard_cli="${TEST_ROOT}/case/stale-guard-cli"
make_cli "${stale_guard_cli}" valid
WORK_DIR="${TEST_ROOT}/case/stale-guard-work"
/bin/mkdir -p "${WORK_DIR}"
ACTIVE_CLI_PID="55101"
ACTIVE_CLI_TREE_PIDS=("55101" "55102")
ACTIVE_CLI_OUTPUT_PATH="${WORK_DIR}/framecull-rawtherapee-version.stale"
/usr/bin/printf '%s\n' "stale-output" > "${ACTIVE_CLI_OUTPUT_PATH}"
typeset -gi stale_guard_status=0
if run_cli_version_with_timeout "${stale_guard_cli}" 1 >/dev/null; then
  print -u2 -r -- "stale CLI guard test: expected fatal status"
  return 1
else
  stale_guard_status=$?
fi
assert_equal "${ACTIVE_CLI_FATAL_EXIT_STATUS}" "${stale_guard_status}" "stale CLI guard exit code"
assert_equal "55101" "${ACTIVE_CLI_PID}" "stale CLI guard preserves active CLI PID"
assert_equal "2" "${#ACTIVE_CLI_TREE_PIDS[@]}" "stale CLI guard preserves active CLI tree size"
assert_equal "${WORK_DIR}/framecull-rawtherapee-version.stale" "${ACTIVE_CLI_OUTPUT_PATH}" "stale CLI guard preserves output path"
assert_path_exists "${ACTIVE_CLI_OUTPUT_PATH}" "stale CLI guard preserves output file"
ACTIVE_CLI_PID=""
ACTIVE_CLI_TREE_PIDS=()
ACTIVE_CLI_OUTPUT_PATH=""
CLI_VERSION_OUTPUT=""

run_cli_version_with_timeout() {
  FRAMECULL_TEST_FATAL_RUN_CLI_CALLS=$((FRAMECULL_TEST_FATAL_RUN_CLI_CALLS + 1))
  if (( FRAMECULL_TEST_FATAL_RUN_CLI_CALLS == 1 )); then
    ACTIVE_CLI_PID="66101"
    ACTIVE_CLI_TREE_PIDS=("66101" "66102")
    ACTIVE_CLI_OUTPUT_PATH="${FRAMECULL_TEST_FATAL_OUTPUT_PATH}"
    CLI_VERSION_OUTPUT=""
    /usr/bin/printf "%s\n" "fatal-output" > "${ACTIVE_CLI_OUTPUT_PATH}"
    return "${ACTIVE_CLI_FATAL_EXIT_STATUS}"
  fi
  FRAMECULL_TEST_FATAL_SECOND_CALLS=$((FRAMECULL_TEST_FATAL_SECOND_CALLS + 1))
  return 0
}
reset_fixture
fatal_raw_app="${TEST_ROOT}/case/Applications/RawTherapee.app"
fatal_first_cli="${TEST_ROOT}/case/managed/rawtherapee-cli"
fatal_second_cli="${TEST_ROOT}/case/usr-local/rawtherapee-cli"
/bin/mkdir -p "${fatal_raw_app}"
make_cli "${fatal_first_cli}" valid
make_cli "${fatal_second_cli}" valid
WORK_DIR="${TEST_ROOT}/case/fatal-determine-work"
/bin/mkdir -p "${WORK_DIR}"
FRAMECULL_TEST_FATAL_OUTPUT_PATH="${WORK_DIR}/framecull-rawtherapee-version.fatal"
typeset -gi FRAMECULL_TEST_FATAL_RUN_CLI_CALLS=0
typeset -gi FRAMECULL_TEST_FATAL_SECOND_CALLS=0
HEALTHY_RAW_CLI=""
INSTALL_MODE=""
CLI_VERSION_OUTPUT=""
typeset -gi fatal_determine_status=0
if determine_install_mode "${fatal_raw_app}" "${fatal_first_cli}" "${fatal_second_cli}" >/dev/null; then
  print -u2 -r -- "fatal determine test: expected determine_install_mode to fail"
  return 1
else
  fatal_determine_status=$?
fi
assert_equal "${ACTIVE_CLI_FATAL_EXIT_STATUS}" "${fatal_determine_status}" "fatal determine exit code"
assert_equal "1" "${FRAMECULL_TEST_FATAL_RUN_CLI_CALLS}" "fatal determine stops after first probe"
assert_equal "0" "${FRAMECULL_TEST_FATAL_SECOND_CALLS}" "fatal determine must not probe second candidate"
assert_equal "" "${HEALTHY_RAW_CLI}" "fatal determine must not set healthy CLI"
assert_equal "" "${INSTALL_MODE}" "fatal determine must not fall back to REPAIR"
assert_equal "66101" "${ACTIVE_CLI_PID}" "fatal determine preserves active CLI PID"
assert_equal "2" "${#ACTIVE_CLI_TREE_PIDS[@]}" "fatal determine preserves active CLI tree size"
assert_equal "${WORK_DIR}/framecull-rawtherapee-version.fatal" "${ACTIVE_CLI_OUTPUT_PATH}" "fatal determine preserves output path"
assert_path_exists "${ACTIVE_CLI_OUTPUT_PATH}" "fatal determine preserves output file"
assert_path_exists "${WORK_DIR}" "fatal determine preserves work dir"
functions[run_cli_version_with_timeout]="${PRODUCTION_RUN_CLI_VERSION_WITH_TIMEOUT}"
ACTIVE_CLI_PID=""
ACTIVE_CLI_TREE_PIDS=()
ACTIVE_CLI_OUTPUT_PATH=""
CLI_VERSION_OUTPUT=""

is_rawtherapee_version_output 'RawTherapee, version 5'
is_rawtherapee_version_output 'RawTherapee, version 5.12'
is_rawtherapee_version_output 'RawTherapee, version 5.12-test'
is_rawtherapee_version_output 'RawTherapee, version 6.0.1+foo'
assert_false "RawTherapee initialization failure must not be a version" \
  is_rawtherapee_version_output 'RawTherapee, version 5 failed initialization'

typeset -gi frame_calls=0
typeset -gi repair_calls=0
install_frame_only() { frame_calls=$((frame_calls + 1)); }
repair_rawtherapee_and_install_frame() { repair_calls=$((repair_calls + 1)); }

run_install_for_mode "${MODE_UPDATE}"
assert_equal "1" "${frame_calls}" "FrameCull update call count"
assert_equal "0" "${repair_calls}" "RawTherapee repair call count"

functions[install_frame_only]="${PRODUCTION_INSTALL_FRAME_ONLY}"
typeset -gi update_attach_calls=0
typeset -gi update_raw_attach_calls=0
typeset -gi update_extract_calls=0
typeset -gi update_frame_privileged_calls=0
typeset -gi update_raw_privileged_calls=0
typeset -gi update_cli_install_calls=0
FRAME_DMG="${TEST_ROOT}/FrameCull.dmg"
/usr/bin/touch "${FRAME_DMG}"
attach_dmg_readonly() {
  local dmg="$1"
  update_attach_calls=$((update_attach_calls + 1))
  if [[ "${dmg}" == *RawTherapee* ]]; then
    update_raw_attach_calls=$((update_raw_attach_calls + 1))
  fi
  ATTACHED_MOUNT_POINT="${TEST_ROOT}/frame-mount"
  /bin/mkdir -p "${ATTACHED_MOUNT_POINT}/FrameCull AI Pro.app"
}
extract_rawtherapee_payload() { update_extract_calls=$((update_extract_calls + 1)); }
install_frame_only_privileged() {
  update_frame_privileged_calls=$((update_frame_privileged_calls + 1))
  return 0
}
install_frame_and_raw_privileged() { update_raw_privileged_calls=$((update_raw_privileged_calls + 1)); }
install_cli_for_user() { update_cli_install_calls=$((update_cli_install_calls + 1)); }
verify_frame_signature() { return 0; }

install_frame_only
assert_equal "1" "${update_attach_calls}" "UPDATE total DMG attach count"
assert_equal "0" "${update_raw_attach_calls}" "UPDATE RawTherapee DMG attach count"
assert_equal "0" "${update_extract_calls}" "UPDATE RawTherapee extraction count"
assert_equal "1" "${update_frame_privileged_calls}" "UPDATE FrameCull privileged install count"
assert_equal "0" "${update_raw_privileged_calls}" "UPDATE RawTherapee authorization/copy/xattr count"
assert_equal "0" "${update_cli_install_calls}" "UPDATE CLI install count"

functions[main]="${PRODUCTION_MAIN}"
typeset -gi verify_extract_calls=0
typeset -gi verify_attach_calls=0
typeset -gi verify_privileged_calls=0
typeset -gi verify_install_calls=0
typeset -gi verify_open_calls=0
verify_package_contract() { :; }
extract_rawtherapee_payload() { verify_extract_calls=$((verify_extract_calls + 1)); }
attach_dmg_readonly() { verify_attach_calls=$((verify_attach_calls + 1)); }
install_frame_only_privileged() { verify_privileged_calls=$((verify_privileged_calls + 1)); }
install_frame_and_raw_privileged() { verify_privileged_calls=$((verify_privileged_calls + 1)); }
install_cli_for_user() { verify_install_calls=$((verify_install_calls + 1)); }
cleanup() { return 0; }
open_frame_app() { verify_open_calls=$((verify_open_calls + 1)); }

main --verify-only
trap '/bin/rm -rf -- "${TEST_ROOT}"' EXIT
assert_equal "1" "${verify_extract_calls}" "VERIFY_ONLY extraction count"
assert_equal "0" "${verify_attach_calls}" "VERIFY_ONLY attach count"
assert_equal "0" "${verify_privileged_calls}" "VERIFY_ONLY authorization/copy/xattr count"
assert_equal "0" "${verify_install_calls}" "VERIFY_ONLY install count"
assert_equal "0" "${verify_open_calls}" "VERIFY_ONLY open count"

functions[attach_dmg_readonly]="${PRODUCTION_ATTACH_DMG_READONLY}"
functions[cleanup]="${PRODUCTION_CLEANUP}"
MOUNTED_DEVICES=()
WORK_DIR="${TEST_ROOT}/attach-work"
/bin/mkdir -p "${WORK_DIR}"
typeset -a detached_devices
detached_devices=()
typeset -gi info_calls=0
license_response_path="${TEST_ROOT}/attach-license-response"
run_hdiutil() {
  if [[ "$1" == "info" ]]; then
    info_calls=$((info_calls + 1))
    print -r -- "empty-info"
    return 0
  fi
  if [[ "$1" == "attach" ]]; then
    local license_response=""
    IFS= read -r license_response || :
    print -r -- "${license_response}" >"${license_response_path}"
    print -r -- "valid-attach"
    return 0
  fi
  if [[ "$1" == "detach" ]]; then
    detached_devices+=("$2")
    return 0
  fi
  return 1
}
validate_plist() { return 0; }
read_plist_type() {
  local plist="$1"
  local key_path="$2"
  local marker="$(<"${plist}")"
  if [[ "${marker}" == "empty-info" && "${key_path}" == "images" ]]; then
    print -r -- "array"
    return 0
  fi
  if [[ "${marker}" == "valid-attach" && "${key_path}" == "system-entities" ]]; then
    print -r -- "array"
    return 0
  fi
  return 1
}
read_plist_array_count() {
  local marker="$(<"$1")"
  local key_path="$2"
  if [[ "${marker}" == "valid-attach" && "${key_path}" == "system-entities" ]]; then
    print -r -- "1"
    return 0
  fi
  if [[ "${marker}" == "empty-info" && "${key_path}" == "images" ]]; then
    print -r -- "0"
    return 0
  fi
  return 1
}
plist_key_exists() {
  local plist="$1"
  local key_path="$2"
  local marker="$(<"${plist}")"
  [[ "${marker}" == "valid-attach" && "${key_path}" == "system-entities.0.dev-entry" ]] && return 0
  [[ "${marker}" == "valid-attach" && "${key_path}" == "system-entities.0.mount-point" ]] && return 0
  return 1
}
read_plist_value() {
  local plist="$1"
  local index="$2"
  local key="$3"
  local marker="$(<"${plist}")"
  if [[ "${marker}" == "valid-attach" && "${index}" == "0" && "${key}" == "dev-entry" ]]; then
    print -r -- "/dev/new"
    return 0
  fi
  if [[ "${marker}" == "valid-attach" && "${index}" == "0" && "${key}" == "mount-point" ]]; then
    print -r -- "/Volumes/FrameCull"
    return 0
  fi
  return 1
}
read_plist_path_value() { return 1; }
attach_dmg_readonly "${FRAME_DMG}"
assert_equal "1" "${#MOUNTED_DEVICES[@]}" "legal plist end registered device count"
assert_equal "/dev/new" "${MOUNTED_DEVICES[1]}" "legal plist end registered device"
assert_equal "/Volumes/FrameCull" "${ATTACHED_MOUNT_POINT}" "legal plist end mount point"
recorded_license_response=""
IFS= read -r recorded_license_response <"${license_response_path}"
assert_equal "Y" "${recorded_license_response}" "DMG attach embedded license response"
cleanup
assert_equal "1" "${#detached_devices[@]}" "legal plist end detach count"
assert_equal "/dev/new" "${detached_devices[1]}" "legal plist end detached device"

MOUNTED_DEVICES=()
ATTACHED_MOUNT_POINT=""
WORK_DIR="${TEST_ROOT}/attach-root-slice-work"
/bin/mkdir -p "${WORK_DIR}"
detached_devices=()
run_hdiutil() {
  if [[ "$1" == "info" ]]; then
    print -r -- "empty-info"
    return 0
  fi
  if [[ "$1" == "attach" ]]; then
    print -r -- "valid-attach-root-slice"
    return 0
  fi
  if [[ "$1" == "detach" ]]; then
    detached_devices+=("$2")
    return 0
  fi
  return 1
}
validate_plist() { return 0; }
read_plist_type() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    empty-info:images|valid-attach-root-slice:system-entities)
      print -r -- "array"
      return 0
      ;;
  esac
  return 1
}
read_plist_array_count() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    empty-info:images)
      print -r -- "0"
      ;;
    valid-attach-root-slice:system-entities)
      print -r -- "2"
      ;;
    *)
      return 1
      ;;
  esac
}
plist_key_exists() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    valid-attach-root-slice:system-entities.0.dev-entry|valid-attach-root-slice:system-entities.1.dev-entry|valid-attach-root-slice:system-entities.1.mount-point)
      return 0
      ;;
  esac
  return 1
}
read_plist_value() {
  local marker="$(<"$1")"
  local index="$2"
  local key="$3"
  case "${marker}:${index}:${key}" in
    valid-attach-root-slice:0:dev-entry)
      print -r -- "/dev/disk7"
      ;;
    valid-attach-root-slice:1:dev-entry)
      print -r -- "/dev/disk7s1"
      ;;
    valid-attach-root-slice:1:mount-point)
      print -r -- "/Volumes/FrameCull"
      ;;
    *)
      return 1
      ;;
  esac
}
read_plist_path_value() { return 1; }
attach_dmg_readonly "${FRAME_DMG}"
assert_equal "1" "${#MOUNTED_DEVICES[@]}" "root plus slice registered root count"
assert_equal "/dev/disk7" "${MOUNTED_DEVICES[1]}" "root plus slice registered whole disk"
cleanup
assert_equal "1" "${#detached_devices[@]}" "root plus slice detach count"
assert_equal "/dev/disk7" "${detached_devices[1]}" "root plus slice detached only root"

MOUNTED_DEVICES=()
ATTACHED_MOUNT_POINT=""
WORK_DIR="${TEST_ROOT}/attach-apfs-synthesized-work"
/bin/mkdir -p "${WORK_DIR}"
detached_devices=()
run_hdiutil() {
  if [[ "$1" == "info" ]]; then
    print -r -- "empty-info"
    return 0
  fi
  if [[ "$1" == "attach" ]]; then
    print -r -- "valid-attach-apfs-synthesized"
    return 0
  fi
  if [[ "$1" == "detach" ]]; then
    detached_devices+=("$2")
    return 0
  fi
  return 1
}
validate_plist() { return 0; }
read_plist_type() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    empty-info:images|valid-attach-apfs-synthesized:system-entities)
      print -r -- "array"
      return 0
      ;;
  esac
  return 1
}
read_plist_array_count() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    empty-info:images)
      print -r -- "0"
      ;;
    valid-attach-apfs-synthesized:system-entities)
      print -r -- "4"
      ;;
    *)
      return 1
      ;;
  esac
}
plist_key_exists() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    valid-attach-apfs-synthesized:system-entities.[0-3].dev-entry|valid-attach-apfs-synthesized:system-entities.3.mount-point)
      return 0
      ;;
  esac
  return 1
}
read_plist_value() {
  local marker="$(<"$1")"
  local index="$2"
  local key="$3"
  case "${marker}:${index}:${key}" in
    valid-attach-apfs-synthesized:0:dev-entry)
      print -r -- "/dev/disk9"
      ;;
    valid-attach-apfs-synthesized:1:dev-entry)
      print -r -- "/dev/disk9s1"
      ;;
    valid-attach-apfs-synthesized:2:dev-entry)
      print -r -- "/dev/disk10"
      ;;
    valid-attach-apfs-synthesized:3:dev-entry)
      print -r -- "/dev/disk10s1"
      ;;
    valid-attach-apfs-synthesized:3:mount-point)
      print -r -- "/Volumes/RawTherapee"
      ;;
    *)
      return 1
      ;;
  esac
}
read_plist_path_value() { return 1; }
attach_dmg_readonly "${FRAME_DMG}"
assert_equal "1" "${#MOUNTED_DEVICES[@]}" "APFS synthesized attach registered device count"
assert_equal "/dev/disk10" "${MOUNTED_DEVICES[1]}" "APFS synthesized attach registered mounted volume root"
assert_equal "/Volumes/RawTherapee" "${ATTACHED_MOUNT_POINT}" "APFS synthesized attach mount point"
cleanup
assert_equal "1" "${#detached_devices[@]}" "APFS synthesized attach detach count"
assert_equal "/dev/disk10" "${detached_devices[1]}" "APFS synthesized attach detached mounted volume root only"

MOUNTED_DEVICES=()
ATTACHED_MOUNT_POINT=""
WORK_DIR="${TEST_ROOT}/attach-slice-only-work"
/bin/mkdir -p "${WORK_DIR}"
detached_devices=()
run_hdiutil() {
  if [[ "$1" == "info" ]]; then
    print -r -- "empty-info"
    return 0
  fi
  if [[ "$1" == "attach" ]]; then
    print -r -- "valid-attach-slice-only"
    return 0
  fi
  if [[ "$1" == "detach" ]]; then
    detached_devices+=("$2")
    return 0
  fi
  return 1
}
validate_plist() { return 0; }
read_plist_type() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    empty-info:images|valid-attach-slice-only:system-entities)
      print -r -- "array"
      return 0
      ;;
  esac
  return 1
}
read_plist_array_count() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    empty-info:images)
      print -r -- "0"
      ;;
    valid-attach-slice-only:system-entities)
      print -r -- "1"
      ;;
    *)
      return 1
      ;;
  esac
}
plist_key_exists() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    valid-attach-slice-only:system-entities.0.dev-entry|valid-attach-slice-only:system-entities.0.mount-point)
      return 0
      ;;
  esac
  return 1
}
read_plist_value() {
  local marker="$(<"$1")"
  local index="$2"
  local key="$3"
  case "${marker}:${index}:${key}" in
    valid-attach-slice-only:0:dev-entry)
      print -r -- "/dev/disk8s2"
      ;;
    valid-attach-slice-only:0:mount-point)
      print -r -- "/Volumes/FrameCull"
      ;;
    *)
      return 1
      ;;
  esac
}
read_plist_path_value() { return 1; }
attach_dmg_readonly "${FRAME_DMG}"
assert_equal "1" "${#MOUNTED_DEVICES[@]}" "slice-only registered root count"
assert_equal "/dev/disk8" "${MOUNTED_DEVICES[1]}" "slice-only normalized whole disk"
cleanup
assert_equal "1" "${#detached_devices[@]}" "slice-only detach count"
assert_equal "/dev/disk8" "${detached_devices[1]}" "slice-only detached normalized root"

MOUNTED_DEVICES=()
ATTACHED_MOUNT_POINT=""
WORK_DIR="${TEST_ROOT}/attach-fallback-work"
/bin/mkdir -p "${WORK_DIR}"
detached_devices=()
info_calls=0
run_hdiutil() {
  if [[ "$1" == "info" ]]; then
    info_calls=$((info_calls + 1))
    if (( info_calls == 1 )); then
      print -r -- "before-info"
    else
      print -r -- "after-info"
    fi
    return 0
  fi
  if [[ "$1" == "attach" ]]; then
    print -r -- "malformed-attach"
    return 0
  fi
  if [[ "$1" == "detach" ]]; then
    detached_devices+=("$2")
    return 0
  fi
  return 1
}
validate_plist() {
  [[ "$(<"$1")" != "malformed-attach" ]]
}
read_plist_type() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    before-info:images|before-info:images.0.system-entities|after-info:images|after-info:images.0.system-entities)
      print -r -- "array"
      return 0
      ;;
  esac
  return 1
}
read_plist_array_count() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    before-info:images|after-info:images)
      print -r -- "1"
      ;;
    before-info:images.0.system-entities)
      print -r -- "1"
      ;;
    after-info:images.0.system-entities)
      print -r -- "2"
      ;;
    *)
      return 1
      ;;
  esac
}
plist_key_exists() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    before-info:images.0.image-path|before-info:images.0.system-entities|before-info:images.0.system-entities.0.dev-entry)
      return 0
      ;;
    after-info:images.0.image-path|after-info:images.0.system-entities|after-info:images.0.system-entities.0.dev-entry|after-info:images.0.system-entities.1.dev-entry)
      return 0
      ;;
  esac
  return 1
}
read_plist_value() {
  return 1
}
read_plist_path_value() {
  local marker="$(<"$1")"
  local key_path="$2"
  if [[ "${key_path}" == "images.0.image-path" ]]; then
    print -r -- "${FRAME_DMG}"
    return 0
  fi
  if [[ "${key_path}" == "images.0.system-entities.0.dev-entry" ]]; then
    print -r -- "/dev/existing"
    return 0
  fi
  if [[ "${marker}" == "after-info" && "${key_path}" == "images.0.system-entities.1.dev-entry" ]]; then
    print -r -- "/dev/new"
    return 0
  fi
  return 1
}
typeset -gi fallback_attach_failed=0
if attach_dmg_readonly "${FRAME_DMG}"; then
  print -u2 -r -- "fallback attach parse failure test: expected failure"
  return 1
else
  fallback_attach_failed=1
fi
assert_equal "1" "${fallback_attach_failed}" "fallback attach parse failure result"
assert_equal "2" "${info_calls}" "fallback hdiutil info snapshot count"
assert_equal "1" "${#MOUNTED_DEVICES[@]}" "fallback registered new device count"
assert_equal "/dev/new" "${MOUNTED_DEVICES[1]}" "fallback registered only new device"
cleanup
assert_equal "1" "${#detached_devices[@]}" "fallback detach count"
assert_equal "/dev/new" "${detached_devices[1]}" "fallback detached only new device"

MOUNTED_DEVICES=()
ATTACHED_MOUNT_POINT=""
WORK_DIR="${TEST_ROOT}/attach-fallback-scoped-work"
/bin/mkdir -p "${WORK_DIR}"
detached_devices=()
info_calls=0
run_hdiutil() {
  if [[ "$1" == "info" ]]; then
    info_calls=$((info_calls + 1))
    if (( info_calls == 1 )); then
      print -r -- "scoped-before-info"
    else
      print -r -- "scoped-after-info"
    fi
    return 0
  fi
  if [[ "$1" == "attach" ]]; then
    print -r -- "malformed-attach"
    return 0
  fi
  if [[ "$1" == "detach" ]]; then
    detached_devices+=("$2")
    return 0
  fi
  return 1
}
validate_plist() {
  [[ "$(<"$1")" != "malformed-attach" ]]
}
read_plist_type() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    scoped-before-info:images|scoped-after-info:images|scoped-before-info:images.*.system-entities|scoped-after-info:images.*.system-entities)
      print -r -- "array"
      return 0
      ;;
  esac
  return 1
}
read_plist_array_count() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    scoped-before-info:images)
      print -r -- "2"
      ;;
    scoped-after-info:images)
      print -r -- "3"
      ;;
    scoped-before-info:images.0.system-entities|scoped-before-info:images.1.system-entities|scoped-after-info:images.0.system-entities|scoped-after-info:images.1.system-entities|scoped-after-info:images.2.system-entities)
      print -r -- "1"
      ;;
    *)
      return 1
      ;;
  esac
}
plist_key_exists() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    scoped-before-info:images.*.image-path|scoped-after-info:images.*.image-path|scoped-before-info:images.*.system-entities|scoped-after-info:images.*.system-entities|scoped-before-info:images.*.system-entities.0.dev-entry|scoped-after-info:images.*.system-entities.0.dev-entry)
      return 0
      ;;
  esac
  return 1
}
read_plist_value() { return 1; }
read_plist_path_value() {
  local marker="$(<"$1")"
  local key_path="$2"
  case "${marker}:${key_path}" in
    scoped-before-info:images.0.image-path|scoped-after-info:images.0.image-path|scoped-after-info:images.1.image-path)
      print -r -- "${FRAME_DMG}"
      ;;
    scoped-before-info:images.1.image-path|scoped-after-info:images.2.image-path)
      print -r -- "${TEST_ROOT}/Other.dmg"
      ;;
    scoped-before-info:images.0.system-entities.0.dev-entry|scoped-after-info:images.0.system-entities.0.dev-entry)
      print -r -- "/dev/disk20"
      ;;
    scoped-before-info:images.1.system-entities.0.dev-entry)
      print -r -- "/dev/disk30"
      ;;
    scoped-after-info:images.1.system-entities.0.dev-entry)
      print -r -- "/dev/disk21s1"
      ;;
    scoped-after-info:images.2.system-entities.0.dev-entry)
      print -r -- "/dev/disk31"
      ;;
    *)
      return 1
      ;;
  esac
}
if attach_dmg_readonly "${FRAME_DMG}"; then
  print -u2 -r -- "scoped fallback attach parse failure test: expected failure"
  return 1
fi
assert_equal "1" "${#MOUNTED_DEVICES[@]}" "scoped fallback registered target-only new root count"
assert_equal "/dev/disk21" "${MOUNTED_DEVICES[1]}" "scoped fallback registered target image root"
cleanup
assert_equal "1" "${#detached_devices[@]}" "scoped fallback detach count"
assert_equal "/dev/disk21" "${detached_devices[1]}" "scoped fallback detached target image root only"

for fallback_apfs_variant in canonical reordered; do
  MOUNTED_DEVICES=()
  ATTACHED_MOUNT_POINT=""
  WORK_DIR="${TEST_ROOT}/attach-fallback-apfs-${fallback_apfs_variant}-work"
  /bin/mkdir -p "${WORK_DIR}"
  detached_devices=()
  info_calls=0
  run_hdiutil() {
    if [[ "$1" == "info" ]]; then
      info_calls=$((info_calls + 1))
      if (( info_calls == 1 )); then
        print -r -- "fallback-apfs-${fallback_apfs_variant}-before-info"
      else
        print -r -- "fallback-apfs-${fallback_apfs_variant}-after-info"
      fi
      return 0
    fi
    if [[ "$1" == "attach" ]]; then
      print -r -- "malformed-attach"
      return 0
    fi
    if [[ "$1" == "detach" ]]; then
      detached_devices+=("$2")
      return 0
    fi
    return 1
  }
  validate_plist() {
    [[ "$(<"$1")" != "malformed-attach" ]]
  }
  read_plist_type() {
    local marker="$(<"$1")"
    local key_path="$2"
    case "${marker}:${key_path}" in
      fallback-apfs-*-before-info:images|fallback-apfs-*-after-info:images|fallback-apfs-*-after-info:images.0.system-entities)
        print -r -- "array"
        return 0
        ;;
    esac
    return 1
  }
  read_plist_array_count() {
    local marker="$(<"$1")"
    local key_path="$2"
    case "${marker}:${key_path}" in
      fallback-apfs-*-before-info:images)
        print -r -- "0"
        ;;
      fallback-apfs-*-after-info:images)
        print -r -- "1"
        ;;
      fallback-apfs-*-after-info:images.0.system-entities)
        print -r -- "4"
        ;;
      *)
        return 1
        ;;
    esac
  }
  plist_key_exists() {
    local marker="$(<"$1")"
    local key_path="$2"
    case "${marker}:${key_path}" in
      fallback-apfs-*-after-info:images.0.image-path|fallback-apfs-*-after-info:images.0.system-entities|fallback-apfs-*-after-info:images.0.system-entities.[0-3].dev-entry)
        return 0
        ;;
      fallback-apfs-canonical-after-info:images.0.system-entities.3.mount-point|fallback-apfs-reordered-after-info:images.0.system-entities.1.mount-point)
        return 0
        ;;
    esac
    return 1
  }
  read_plist_value() { return 1; }
  read_plist_path_value() {
    local marker="$(<"$1")"
    local key_path="$2"
    case "${marker}:${key_path}" in
      fallback-apfs-*-after-info:images.0.image-path)
        print -r -- "${FRAME_DMG}"
        ;;
      fallback-apfs-canonical-after-info:images.0.system-entities.0.dev-entry)
        print -r -- "/dev/disk9"
        ;;
      fallback-apfs-canonical-after-info:images.0.system-entities.1.dev-entry)
        print -r -- "/dev/disk9s1"
        ;;
      fallback-apfs-canonical-after-info:images.0.system-entities.2.dev-entry)
        print -r -- "/dev/disk10"
        ;;
      fallback-apfs-canonical-after-info:images.0.system-entities.3.dev-entry)
        print -r -- "/dev/disk10s1"
        ;;
      fallback-apfs-reordered-after-info:images.0.system-entities.0.dev-entry)
        print -r -- "/dev/disk9s1"
        ;;
      fallback-apfs-reordered-after-info:images.0.system-entities.1.dev-entry)
        print -r -- "/dev/disk10s1"
        ;;
      fallback-apfs-reordered-after-info:images.0.system-entities.2.dev-entry)
        print -r -- "/dev/disk9"
        ;;
      fallback-apfs-reordered-after-info:images.0.system-entities.3.dev-entry)
        print -r -- "/dev/disk10"
        ;;
      fallback-apfs-canonical-after-info:images.0.system-entities.3.mount-point|fallback-apfs-reordered-after-info:images.0.system-entities.1.mount-point)
        print -r -- "/Volumes/RawTherapee"
        ;;
      *)
        return 1
        ;;
    esac
  }
  typeset -gi fallback_apfs_attach_failed=0
  if attach_dmg_readonly "${FRAME_DMG}"; then
    print -u2 -r -- "${fallback_apfs_variant} APFS fallback attach test: expected failure"
    return 1
  else
    fallback_apfs_attach_failed=1
  fi
  assert_equal "1" "${fallback_apfs_attach_failed}" "${fallback_apfs_variant} APFS fallback attach failure result"
  assert_equal "2" "${info_calls}" "${fallback_apfs_variant} APFS fallback info snapshot count"
  assert_equal "1" "${#MOUNTED_DEVICES[@]}" "${fallback_apfs_variant} APFS fallback registered one cleanup device"
  assert_equal "/dev/disk10" "${MOUNTED_DEVICES[1]}" "${fallback_apfs_variant} APFS fallback selected mounted entity root"
  cleanup
  assert_equal "1" "${#detached_devices[@]}" "${fallback_apfs_variant} APFS fallback detach count"
  assert_equal "/dev/disk10" "${detached_devices[1]}" "${fallback_apfs_variant} APFS fallback detached mounted entity root only"
done

transaction_test_root="${TEST_ROOT}/transaction"
/bin/rm -rf -- "${transaction_test_root}"
/bin/mkdir -p "${transaction_test_root}"
transaction_bin_dir="${transaction_test_root}/bin"
make_transaction_test_bins "${transaction_bin_dir}"
frame_only_transaction="$(prepare_transaction_shell_for_test "$(build_frame_only_transaction_shell)" "${transaction_bin_dir}")"
frame_and_raw_transaction="$(prepare_transaction_shell_for_test "$(build_frame_and_raw_transaction_shell)" "${transaction_bin_dir}")"

assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_DITTO_BIN" "Frame-only builder must not honor ditto env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_XATTR_BIN" "Frame-only builder must not honor xattr env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_MKTEMP_BIN" "Frame-only builder must not honor mktemp env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_DIRNAME_BIN" "Frame-only builder must not honor dirname env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_RM_BIN" "Frame-only builder must not honor rm env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_MV_BIN" "Frame-only builder must not honor mv env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_KILL_BIN" "Frame-only builder must not honor kill env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "FRAMECULL_INSTALLER_TEST_SIGNAL_CHECKPOINT" "Frame-only builder must not expose signal checkpoints"
assert_not_contains "${PRODUCTION_BUILD_FRAME_ONLY_TRANSACTION}" "checkpoint()" "Frame-only builder must not define checkpoint hooks"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_DITTO_BIN" "Combined builder must not honor ditto env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_XATTR_BIN" "Combined builder must not honor xattr env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_MKTEMP_BIN" "Combined builder must not honor mktemp env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_DIRNAME_BIN" "Combined builder must not honor dirname env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_RM_BIN" "Combined builder must not honor rm env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_MV_BIN" "Combined builder must not honor mv env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_KILL_BIN" "Combined builder must not honor kill env override"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "FRAMECULL_INSTALLER_TEST_SIGNAL_CHECKPOINT" "Combined builder must not expose signal checkpoints"
assert_not_contains "${PRODUCTION_BUILD_FRAME_AND_RAW_TRANSACTION}" "checkpoint()" "Combined builder must not define checkpoint hooks"

single_case_root="${transaction_test_root}/single-restore-old"
single_apps_dir="${single_case_root}/Applications"
/bin/mkdir -p "${single_apps_dir}"
single_source_app="${single_case_root}/FrameCull-New.app"
single_target_app="${single_apps_dir}/FrameCull AI Pro.app"
make_fake_app_dir "${single_source_app}" "new-frame"
make_fake_app_dir "${single_target_app}" "old-frame"
single_backup_move_transaction="$(inject_term_after_line "${frame_only_transaction}" '/bin/mv "$frameTarget" "$frameBackup"' "single rollback after backup move injection point")"
if ! run_transaction_shell "${single_backup_move_transaction}" "${single_source_app}" "${single_target_app}"; then
  :
fi
assert_app_marker "${single_target_app}" "old-frame" "single rollback after backup move restores old target"
assert_no_transaction_leaks "${single_apps_dir}" "single rollback after backup move leak check"

single_absent_root="${transaction_test_root}/single-restore-absence"
single_absent_apps_dir="${single_absent_root}/Applications"
/bin/mkdir -p "${single_absent_apps_dir}"
single_absent_source_app="${single_absent_root}/FrameCull-New.app"
single_absent_target_app="${single_absent_apps_dir}/FrameCull AI Pro.app"
make_fake_app_dir "${single_absent_source_app}" "new-frame"
single_target_move_transaction="$(inject_term_after_line "${frame_only_transaction}" '/bin/mv "$frameStage" "$frameTarget"' "single rollback after target move injection point")"
if ! run_transaction_shell "${single_target_move_transaction}" "${single_absent_source_app}" "${single_absent_target_app}"; then
  :
fi
assert_path_missing "${single_absent_target_app}" "single rollback after target move restores original absence"
assert_no_transaction_leaks "${single_absent_apps_dir}" "single rollback after target move leak check"

double_case_root="${transaction_test_root}/double-restore-old"
double_apps_dir="${double_case_root}/Applications"
/bin/mkdir -p "${double_apps_dir}"
double_frame_source="${double_case_root}/FrameCull-New.app"
double_raw_source="${double_case_root}/Raw-New.app"
double_frame_target="${double_apps_dir}/FrameCull AI Pro.app"
double_raw_target="${double_apps_dir}/RawTherapee.app"
make_fake_app_dir "${double_frame_source}" "new-frame"
make_fake_app_dir "${double_raw_source}" "new-raw"
make_fake_app_dir "${double_frame_target}" "old-frame"
make_fake_app_dir "${double_raw_target}" "old-raw"
double_frame_move_transaction="$(inject_term_after_line "${frame_and_raw_transaction}" '/bin/mv "$frameStage" "$frameTarget"' "double rollback after FrameCull move injection point")"
if ! run_transaction_shell "${double_frame_move_transaction}" "${double_frame_source}" "${double_frame_target}" "${double_raw_source}" "${double_raw_target}"; then
  :
fi
assert_app_marker "${double_frame_target}" "old-frame" "double rollback restores old FrameCull target"
assert_app_marker "${double_raw_target}" "old-raw" "double rollback restores old RawTherapee target"
assert_no_transaction_leaks "${double_apps_dir}" "double rollback leak check"

assert_contains "${PRODUCTION_INSTALL_FRAME_ONLY_PRIVILEGED}" "/usr/bin/env -i /bin/sh -c" "Frame-only privileged install must execute transaction shell via env -i"
assert_contains "${PRODUCTION_INSTALL_FRAME_AND_RAW_PRIVILEGED}" "/usr/bin/env -i /bin/sh -c" "Combined privileged install must execute transaction shell via env -i"
assert_not_contains "${PRODUCTION_INSTALL_FRAME_ONLY_PRIVILEGED}" "FRAMECULL_INSTALLER_DITTO_BIN" "Frame-only privileged install must not pass caller ditto override"
assert_not_contains "${PRODUCTION_INSTALL_FRAME_AND_RAW_PRIVILEGED}" "FRAMECULL_INSTALLER_DITTO_BIN" "Combined privileged install must not pass caller ditto override"
assert_not_contains "${PRODUCTION_INSTALL_FRAME_ONLY_PRIVILEGED}" "restoreFrame" "Frame-only privileged install must not depend on restoreFrame flag"
assert_not_contains "${PRODUCTION_INSTALL_FRAME_AND_RAW_PRIVILEGED}" "restoreRaw" "Combined privileged install must not depend on restoreRaw flag"

functions[cleanup]="${PRODUCTION_CLEANUP}"
functions[terminate_active_cli]='return 1'
reset_fixture
WORK_DIR="${TEST_ROOT}/case/cleanup-failure-work"
/bin/mkdir -p "${WORK_DIR}"
ACTIVE_CLI_PID="98765"
ACTIVE_CLI_TREE_PIDS=("98765" "98766")
ACTIVE_CLI_OUTPUT_PATH="${WORK_DIR}/framecull-rawtherapee-version.failure"
/usr/bin/printf '%s\n' "still-running" > "${ACTIVE_CLI_OUTPUT_PATH}"
typeset -gi cleanup_failure_exit=0
if cleanup; then
  print -u2 -r -- "cleanup failure preservation test: expected cleanup to fail"
  return 1
else
  cleanup_failure_exit=$?
fi
assert_equal "1" "${cleanup_failure_exit}" "cleanup failure exit code"
assert_equal "98765" "${ACTIVE_CLI_PID}" "cleanup failure preserves active CLI PID"
assert_equal "2" "${#ACTIVE_CLI_TREE_PIDS[@]}" "cleanup failure preserves active CLI tree size"
assert_equal "98765" "${ACTIVE_CLI_TREE_PIDS[1]}" "cleanup failure preserves active CLI root"
assert_equal "98766" "${ACTIVE_CLI_TREE_PIDS[2]}" "cleanup failure preserves active CLI child"
assert_equal "${WORK_DIR}/framecull-rawtherapee-version.failure" "${ACTIVE_CLI_OUTPUT_PATH}" "cleanup failure preserves output path"
assert_path_exists "${ACTIVE_CLI_OUTPUT_PATH}" "cleanup failure preserves output file"
assert_path_exists "${WORK_DIR}" "cleanup failure preserves work dir"
ACTIVE_CLI_PID=""
ACTIVE_CLI_TREE_PIDS=()
ACTIVE_CLI_OUTPUT_PATH=""
WORK_DIR=""

functions[setopt]='return 1'
functions[terminate_active_cli]="${PRODUCTION_TERMINATE_ACTIVE_CLI}"
functions[run_cli_version_with_timeout]="${PRODUCTION_RUN_CLI_VERSION_WITH_TIMEOUT}"
functions[cleanup]="${PRODUCTION_CLEANUP}"
reset_fixture
timeout_cli="${TEST_ROOT}/case/timeout-cli"
timeout_child="${TEST_ROOT}/case/timeout-child"
pid_dir="${TEST_ROOT}/case/pids"
/bin/mkdir -p "${pid_dir}"
/usr/bin/printf '%s\n' \
  '#!/bin/zsh' \
  'set -euo pipefail' \
  '/usr/bin/printf "%s\n" "$$" > "${FRAMECULL_TEST_PID_DIR:?}/wrapper.pid"' \
  '"${FRAMECULL_TEST_CHILD:?}" &' \
  'wait' > "${timeout_cli}"
/usr/bin/printf '%s\n' \
  '#!/bin/zsh' \
  'set -euo pipefail' \
  '/usr/bin/printf "%s\n" "$$" > "${FRAMECULL_TEST_PID_DIR:?}/child.pid"' \
  'typeset -i spawn_count=0' \
  'while true; do' \
  '  /bin/sleep 30 &' \
  '  spawn_pid=$!' \
  '  spawn_count=$((spawn_count + 1))' \
  '  if (( spawn_count == 1 )); then' \
  '    /usr/bin/printf "%s\n" "${spawn_pid}" > "${FRAMECULL_TEST_PID_DIR:?}/grandchild.pid"' \
  '  fi' \
  '  /usr/bin/printf "%s\n" "${spawn_pid}" > "${FRAMECULL_TEST_PID_DIR:?}/late.pid"' \
  '  /bin/sleep 0.02' \
  'done' > "${timeout_child}"
/bin/chmod 755 "${timeout_cli}" "${timeout_child}"
export FRAMECULL_TEST_PID_DIR="${pid_dir}"
export FRAMECULL_TEST_CHILD="${timeout_child}"
WORK_DIR="${TEST_ROOT}/case/work"
/bin/mkdir -p "${WORK_DIR}"
typeset -gi timeout_exit=0
if run_cli_version_with_timeout "${timeout_cli}" 1 >/dev/null; then
  print -u2 -r -- "timeout process tree test: expected timeout"
  return 1
else
  timeout_exit=$?
fi
assert_equal "124" "${timeout_exit}" "timeout exit code"
for attempt in {1..40}; do
  [[ -f "${pid_dir}/grandchild.pid" && -f "${pid_dir}/late.pid" ]] && break
  /bin/sleep 0.05
done
for pid_file in wrapper.pid child.pid grandchild.pid late.pid; do
  [[ -f "${pid_dir}/${pid_file}" ]] || {
    print -u2 -r -- "timeout process tree test: missing ${pid_file}"
    return 1
  }
  process_id="$(<"${pid_dir}/${pid_file}")"
  assert_process_stopped "timeout process tree ${pid_file}" "${process_id}"
done
assert_equal "" "${ACTIVE_CLI_PID:-}" "timeout active CLI PID cleanup"
assert_equal "0" "${#ACTIVE_CLI_TREE_PIDS[@]}" "timeout active CLI tree cleanup"
assert_equal "" "${ACTIVE_CLI_OUTPUT_PATH:-}" "timeout output path cleanup"
typeset -a remaining_cli_outputs
remaining_cli_outputs=("${WORK_DIR}"/framecull-rawtherapee-version.*(N))
assert_equal "0" "${#remaining_cli_outputs[@]}" "timeout output file cleanup"

print -r -- "FrameCull Pro installer state and behavior tests: PASS"
